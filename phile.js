const http2 = require("node:http2");
const http = require("http");
const fsp = require("fs/promises");
const fs = require("fs");

const DEBUG_verbose = false;
// Don't actually save the uploaded data
const DEBUG_simulatedWrite = false;
// Time taken for simulated writes
const DEBUG_simulatedWriteSpeed = 0;

const c_charset = "abcdefghijklmnopqrstuvwxyz";
const c_idLength = 6;
const c_maxTimeBetweenWrites = 1000 * 8; //8s
const c_expiryTime = 1000 * 60 * 60 * 24; //24h
const g_uploadInfos = {};

const {
    HTTP2_HEADER_STATUS,
    HTTP2_HEADER_METHOD,
    HTTP2_HEADER_PATH,
    HTTP2_HEADER_CONTENT_LENGTH,
    HTTP_STATUS_OK,
    HTTP_STATUS_BAD_REQUEST,
    HTTP_STATUS_NOT_FOUND,
    HTTP_STATUS_CREATED,
    HTTP_STATUS_TEMPORARY_REDIRECT,
    HTTP_STATUS_UNAUTHORIZED,
    HTTP_STATUS_INTERNAL_SERVER_ERROR
} = http2.constants;

//generate an ID of random letters in mixed case
function generateID() {
    let id = "";

    for (let i = 0; i < c_idLength; ++i) {
        id += c_charset[Math.floor(Math.random() * c_charset.length)];
    }

    return id;
}

function log(message, stream) {
    let address = "";
    if (stream && stream.session) {
        address = stream.session.socket.remoteAddress;
    }
    console.log(`${address}:${message}`);
}
const vlog = DEBUG_verbose ? log : () => {};

function generateUniqueID() {
    let id;

    do {
        id = generateID();
    } while (g_uploadInfos[id] !== undefined);

    return id;
}

function respondAndEnd(stream, status, endData = undefined, extraHeaders = {}) {
    const headers = {
        [HTTP2_HEADER_STATUS]: status
    };

    for (const header in extraHeaders) {
        headers[header] = extraHeaders[header];
    }

    if (!stream.destroyed) {
        const hasExtraHeaders = Object.keys(extraHeaders).length > 0;
        vlog(`RESPONSE: ${status}${hasExtraHeaders ? `: ${JSON.stringify(extraHeaders)}` : ""}`, stream);
        stream.respond(headers);
        stream.end(endData);
    }
}

//send a file normally to the user
async function sendFile(stream, path) {
    const data = await fsp.readFile(`${__dirname}/${path}`);
    respondAndEnd(stream, HTTP_STATUS_OK, data);
}

async function send404(stream) {
    const data = await fsp.readFile(`${__dirname}/site/404.html`);
    respondAndEnd(stream, HTTP_STATUS_NOT_FOUND, data);
}

async function sendFileListPage(stream, headers, uid) {
    const fileNames = await fsp.readdir(`${__dirname}/uploads/${uid}`);
    const fileListHTML = fileNames.map(fileName => {
        return `<a href="/${uid}/${encodeURI(fileName)}" class="fileTracker download" download><p class="fileName">${fileName}</p></a>`;
    }).join("\r\n");

    const template = await fsp.readFile(`${__dirname}/site/fileList.html`);
    let response = template.toString()
        .replace("{FILE_LIST}", fileListHTML)
        .replace("PHILE_CREATE", g_uploadInfos[uid].completeTime)
        .replace("PHILE_UPLOAD_DURATION", c_expiryTime);

    if (headers.cookie === g_uploadInfos[uid].owner) {
        response = response.replace("{DELETE_BUTTON}", `<a class="button" href="/d/${uid}">X</a>`);
    }
    else {
        response = response.replace("{DELETE_BUTTON}", "");
    }

    respondAndEnd(stream, HTTP_STATUS_OK, response);
}

async function sendUploadFile(stream, uid, fileName) {
    const filePath = `${__dirname}/uploads/${uid}/${fileName}`;
    let fileInfo = null;

    if (!g_uploadInfos[uid]) {
        send404(stream);
        return;
    }

    try {
        fileInfo = await fsp.stat(filePath);
    }
    catch {
        send404(stream);
        return;
    }

    if (!stream.destroyed) {
        stream.respond({
            [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
            "content-length": fileInfo.size,
            "content-disposition": `attachment; filename="${encodeURI(fileName)}"`
        });
        
        vlog(`SENDING ${uid}/${fileName}`, stream);
        const readStream = fs.createReadStream(filePath);
        readStream.pipe(stream);
        
        readStream.on("end", () => {
            log(`SENT ${uid}/${fileName}`, stream);
        });
    }
}

function setDeleteTimeout(uid, time, reason) {
    const uploadInfo = g_uploadInfos[uid];
    if (!uploadInfo) {
        return;
    }
    
    clearTimeout(uploadInfo.deleteTimeout);
    uploadInfo.deleteTimeout = setTimeout(() => {  
        log(`DELETE ${uid}: ${reason}`);

        if (uploadInfo.files) {
            for (const {fd} of Object.values(uploadInfo.files)) {
                if (fd) {
                    fd.close();
                }
            }
        }
        
        delete g_uploadInfos[uid];
        fsp.rm(`${__dirname}/uploads/${uid}`, {recursive: true})
            .catch(e => console.error(`Unable to delete ${uid}. ${e}`));
        saveSession();
    }, time);
}

async function handleNewUploadRequest(stream, headers) {
    const uploadID = generateUniqueID();
    const size = parseInt(headers["total-size"]);
    const guid = headers["guid"];

    if (!guid || !isFinite(size)) {
        respondAndEnd(stream, HTTP_STATUS_BAD_REQUEST);
        return;
    }

    log(`NEW ${uploadID} [${size}]`, stream);

    g_uploadInfos[uploadID] = {
        files: [],
        owner: guid,
        size,
        received: 0,
        written: 0,
        complete: false
    };

    respondAndEnd(stream, HTTP_STATUS_CREATED, `${uploadID}`);
    if (!DEBUG_simulatedWrite) {
        g_uploadInfos.dirCreationPromise = fsp.mkdir(`${__dirname}/uploads/${uploadID}`, {recursive: true});
    }
    setDeleteTimeout(uploadID, c_maxTimeBetweenWrites, "NEW INTERVAL");
}

function writeQueueEmpty({stream, uploadID, uploadObj, fileObj}) {
    vlog(`Write promise ended at ${uploadObj.written} / ${uploadObj.size} bytes`, stream);
    
    fileObj.writePromise = null;

    // Check for upload finish whenever write queue is done
    if (uploadObj.written === uploadObj.size) {
        log(`COMPLETE ${uploadID}`, stream);
        uploadObj.complete = true;
        uploadObj.completeTime = Date.now();

        // Delete the files obj so the chunks aren't kept in memory
        delete uploadObj.files;
        saveSession();
        setDeleteTimeout(uploadID, c_expiryTime, "EXPIRE");
    }
}

function receiveFile(stream, uploadID, uploadObj, fileObj) {
    return new Promise((resolve, reject) => {
        stream.on("data", chunk => {
            uploadObj.received += chunk.length;
            fileObj.received += chunk.length;

            if (fileObj.received > fileObj.size) {
                reject(new Error("Specified file size exceeded"));
            }
            else if (uploadObj.received > uploadObj.size) {
                reject(new Error("Specified upload size exceeded"));
            }
            else {
                fileObj.writeQueue.push(chunk);
    
                // write everything in the queue, else do nothing as
                // the currently running promise will write this data
                if (fileObj.writePromise === null) {
                    const fileData = {stream, uploadID, 
                        uploadObj, fileObj};

                    fileObj.writePromise = startWriting(fileData).catch(reject);
                }
            }
        });
        
        stream.on("end", async () => {
            try {
                if (fileObj.writePromise !== null) {
                    await fileObj.writePromise;
                }
                resolve();
            }
            catch (e) {
                reject(e);
            }
        });

        stream.on("error", reject);
    });
}

function validateDataRequest(stream, headers) {
    const contentLength = parseInt(headers[HTTP2_HEADER_CONTENT_LENGTH]);
    const uploadID = headers["upload-id"];
    const guid = headers["guid"];
    const uploadObj = g_uploadInfos[uploadID];

    let fileName = "";
    let valid = true;
    
    try {
        fileName = decodeURIComponent(Buffer.from(headers["file-name"], "base64"));
    }
    catch (e) { 
        log("Failed to parse file-name header", stream);
        valid = false;
    }
    
    if (!valid || !uploadID || !fileName || !guid || !isFinite(contentLength)) {
        respondAndEnd(stream, HTTP_STATUS_BAD_REQUEST);
        valid = false;
    }
    else if (!uploadObj) {
        send404(stream);
        valid = false;
    }
    else if (guid !== uploadObj.owner) {
        respondAndEnd(stream, HTTP_STATUS_UNAUTHORIZED);
        valid = false;
    }

    return valid ? {contentLength, uploadID, fileName, guid, uploadObj} : null;
}

async function writeChunk({uploadID, uploadObj, fileObj}, chunk) {
    if (uploadObj.dirCreationPromise && !DEBUG_simulatedWrite) {
        await uploadObj.dirCreationPromise;
        delete uploadObj.dirCreationPromise;
    }

    if (!fileObj.fd && !DEBUG_simulatedWrite) {
        fileObj.fd = await fsp.open(`${__dirname}/uploads/${uploadID}/${fileObj.name}`, "wx");
    }

    if (DEBUG_simulatedWrite) {
        if (DEBUG_simulatedWriteSpeed > 0) {
            const sleep = ms => new Promise(r => setTimeout(r, ms));
            await sleep(DEBUG_simulatedWriteSpeed);
        }
    }
    else {
        await fileObj.fd.write(chunk, 0, chunk.length);
    }
    
    fileObj.written += chunk.length;
    uploadObj.written += chunk.length;

    if (fileObj.written > fileObj.size) {
        throw new Error(`Wrote too many bytes for file ${fileObj.name}`);
    }
    if (uploadObj.written > uploadObj.size) {
        throw new Error(`Wrote too many bytes for upload ${uploadID}`);
    }

    if (fileObj.written === fileObj.size && fileObj.fd) {
        log(`SAVED ${uploadID}/${fileObj.name}`);
        fileObj.fd.close();
        fileObj.fd = null;
    }
}

// Writes the first item in the queue for that file
// then checks for another item. Repeats until the queue
// is empty. This is because we shouldn't call fsp.write
// again for a given file until the previous promise is
// resolved.
async function startWriting(fileData) {
    const { uploadID, fileObj: {writeQueue} } = fileData;
    let nextChunk = writeQueue.shift();

    while (nextChunk) {
        setDeleteTimeout(uploadID, c_maxTimeBetweenWrites, "DATA INTERVAL");
        await writeChunk(fileData, nextChunk);
        nextChunk = writeQueue.shift();
    }

    writeQueueEmpty(fileData);
}

async function handleDataRequest(stream, headers) {
    const requestInfo = validateDataRequest(stream, headers);

    if (!requestInfo) {
        log(`DATA INVALID`, stream);
        respondAndEnd(stream, HTTP_STATUS_BAD_REQUEST);
        return;
    }

    const {
        contentLength, uploadID, 
        fileName, uploadObj
    } = requestInfo;
    const fileID = uploadObj.files.length;

    const fileObj = {
        written: 0,
        size: contentLength,
        fd: null,
        name: fileName,
        writePromise: null,
        writeQueue: [],
    };

    uploadObj.files[fileID] = fileObj;
    
    vlog(`FILE ${uploadID}/${fileObj.name}[${fileObj.size}]`, stream);
    
    try {
        await receiveFile(stream, uploadID, uploadObj, fileObj);
        respondAndEnd(stream, HTTP_STATUS_OK);
    }
    catch (e) {
        setDeleteTimeout(uploadID, 0, `File receipt failed`);
        log(`FILE RECEIPT FAILED: ${e}\n${e.stack}`, stream);
        respondAndEnd(stream, HTTP_STATUS_INTERNAL_SERVER_ERROR);
    }
}

function handleFileRequest(stream, headers) {
    const allowedFiles = ["index.html", "main.css", "main.js"];
    const [path1, path2] = headers[HTTP2_HEADER_PATH].substring(1).split("/");
    const path1Lower = path1.toLowerCase();

    if (path1.length === 0) {
        sendFile(stream, "site/index.html");
    }
    else if (allowedFiles.includes(path1)) {
        sendFile(stream, `site/${path1}`);
    }
    else if (path1 === "d") {
        const uploadInfo = g_uploadInfos[path2];
        
        if (uploadInfo && headers.cookie === uploadInfo.owner) {
            setDeleteTimeout(path2, 0, "Requested by owner");
            respondAndEnd(stream, HTTP_STATUS_TEMPORARY_REDIRECT, null, {"Location": "/"});
        }
        else {
            send404(stream);
        }
    }
    else if (Object.keys(g_uploadInfos).includes(path1Lower)) {
        if (path2) {
            sendUploadFile(stream, path1Lower, decodeURI(path2));
        }
        else {
            sendFileListPage(stream, headers, path1);
        }
    }
    else {
        send404(stream);
    }
}

function handleInfoRequest(stream) {
    log("INFO REQUEST NYI", stream);
    respondAndEnd(stream, HTTP_STATUS_BAD_REQUEST);
}

async function saveSession() {
    const sessionObj = {};

    for (const [uid, {owner, complete, completeTime}] of Object.entries(g_uploadInfos)) {
        if (complete) {
            sessionObj[uid] = {owner, completeTime};
        }
    }

    await fsp.mkdir(`${__dirname}/uploads`, {recursive: true});
    fsp.writeFile(`${__dirname}/uploads/session.json`, JSON.stringify(sessionObj));
}

// Restores uploads from the previous
// session if they are still valid
async function recover() {
    try {
        const text = await fsp.readFile(`${__dirname}/uploads/session.json`, "utf8");

        try {
            const session = JSON.parse(text);

            for (const uid in session) {
                const {owner, completeTime} = session[uid];

                if (owner && completeTime) {
                    g_uploadInfos[uid] = {owner, completeTime, complete: true};
                    
                    const timeDiff = Date.now() - completeTime;
                    const remainingTime = c_expiryTime - timeDiff;

                    setDeleteTimeout(uid, remainingTime, "EXPIRE");

                    console.log(`RESTORE ${uid} [${remainingTime}]`);
                }
            }
        }
        catch (e) {
            console.error("Failed to parse session file", e);
        }
    }
    catch {
        console.log("No session file found.");
    }

    // Purge all upload folders that weren't 
    // included in the session file
    try {
        const uploads = await fsp.readdir(`${__dirname}/uploads`);

        for (const entryName of uploads) {
            if (entryName !== "session.json" && !Object.keys(g_uploadInfos).includes(entryName)) {
                console.log(`PURGE ${entryName}`);
                await fsp.rm(`${__dirname}/uploads/${entryName}`, {recursive: true});
            }
        }
    }
    catch {
        console.log("Nothing to purge.");
    }

    saveSession();
}

const options = {
    port: 42443,
    host: "0.0.0.0",
    key: fs.readFileSync(process.argv[2], "utf8"),
    cert: fs.readFileSync(process.argv[3], "utf8"),
};

const server = http2.createSecureServer(options);
server.on("error", e => console.error(e));

server.on("stream", (stream, headers) => {
    const method = headers[HTTP2_HEADER_METHOD];
    const handlers = {
        "GET": handleFileRequest,
        "POST": handleNewUploadRequest,
        "PATCH": handleDataRequest,
        "INFO" : handleInfoRequest,
    };

    vlog(`${method} ${headers[HTTP2_HEADER_PATH]}`, stream);

    const handler = handlers[method];

    if (handler) {
        handler(stream, headers);
    }
    else {
        log(`NO HANDLER: ${method}`, stream);
        respondAndEnd(stream, HTTP_STATUS_BAD_REQUEST);
    }
});

recover().then(() => {
    server.listen(options, () => {
        console.log(`Listening on ${options.port}`);
    });
});

const redirectServer = http.createServer((req, res) => {
    res.writeHead(301, {
        "Location": `https://${req.headers.host}${req.url}`
    });
    res.end();
});

redirectServer.listen(42080);
