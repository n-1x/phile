const http2 = require("node:http2");
const http = require("http");
const fsp = require("fs/promises");
const fs = require("fs");

const DEBUG_verbose = false;
// Don't actually save the uploaded data
const DEBUG_simulateWrites = false;
// Time taken for simulated writes
const DEBUG_writeTime = 4;

const c_charset = "abcdefghijklmnopqrstuvwxyz";
const c_idLength = 6;
const c_maxPatchInterval = 1000 * 30;
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
    HTTP_STATUS_TEMPORARY_REDIRECT
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
    if (DEBUG_verbose && stream && stream.session) {
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
        stream.respond(headers);
        stream.end(endData);
    }
}

//send a file normally to the user
async function sendFile(stream, path, headers = {}) {
    let fd = null;

    try {
        fd = await fsp.open(`${__dirname}/${path}`);
    }
    catch (e) {
        fd = await fsp.open(`${__dirname}/site/404.html`);
        headers[HTTP2_HEADER_STATUS] = HTTP_STATUS_NOT_FOUND;
    }

    if (!stream.destroyed) {
        stream.respondWithFD(fd, headers);
        stream.on("close", fd.close);
    }
}

async function send404(stream) {
    sendFile(stream, `site/404.html`,
        { [HTTP2_HEADER_STATUS]: HTTP_STATUS_NOT_FOUND});
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
    const filePath = `uploads/${uid}/${fileName}`;

    if (!g_uploadInfos[uid]) {
        send404(stream);
        return;
    }

    sendFile(stream, filePath);
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

function fileComplete(uploadObj, fileObj) {
    log(`FILE DONE ${uploadObj.id}/${fileObj.id}:${fileObj.name}`);

    if (uploadObj.received === uploadObj.size) {
        log(`COMPLETE ${uploadObj.id}`);
        uploadObj.completeTime = Date.now();
        setDeleteTimeout(uploadObj.id, c_expiryTime);
        saveSession();
    }

    if (fileObj.fd) {
        fileObj.fd.close();
        delete fileObj.fd;
    }
}

async function handleNewUploadRequest(stream, headers) {
    const uploadID = generateUniqueID();
    const size = parseInt(headers["00uploadsize"]);
    const guid = headers["00guid"];

    if (!guid || !isFinite(size)) {
        respondAndEnd(stream, HTTP_STATUS_BAD_REQUEST);
        return;
    }

    log(`NEW ${uploadID} [${size}]`, stream);

    g_uploadInfos[uploadID] = {
        id: uploadID,
        files: {},
        owner: guid,
        size,
        received: 0,
        completeTime: null
    };

    respondAndEnd(stream, HTTP_STATUS_CREATED, `${uploadID}`);
    if (!DEBUG_simulateWrites) {
        g_uploadInfos.dirCreationPromise = fsp.mkdir(`${__dirname}/uploads/${uploadID}`, {recursive: true});
    }
    setDeleteTimeout(uploadID, c_maxPatchInterval, "NEW INTERVAL");
}

async function handlePatchRequest(stream, headers) {
    let requestInfo = null;
    
    try {
        requestInfo = validatePatchHeaders(headers);
    }
    catch (e) {
        log(`Data request validation failed: ${e}`, stream);
    }

    if (!requestInfo) {
        log(`DATA INVALID`, stream);
        respondAndEnd(stream, HTTP_STATUS_BAD_REQUEST);
        return;
    }

    const {
        fileName, uploadObj,
        fileID, fileSize
    } = requestInfo;
    
    if (!(fileID in uploadObj.files)) {
        log(`FILE START ${uploadObj.id}/${fileName}`);
        const fileObj = {
            id: fileID, received: 0, size: fileSize, name: fileName
        };

        if (!DEBUG_simulateWrites) {
            fileObj.fd = await fsp.open(
                `${__dirname}/uploads/${uploadObj.id}/${fileName}`, "wx");
            fileObj.writeStream = fileObj.fd.createWriteStream();
        }

        uploadObj.files[fileID] = fileObj;
    }
    
    setDeleteTimeout(uploadObj.id, c_maxPatchInterval, "Patch interval exceeded");
    
    let status = HTTP_STATUS_OK;
    try {
        await receiveFileData(stream, uploadObj, uploadObj.files[fileID]);
    }
    catch (e) {
        setDeleteTimeout(uploadObj.id, 0, `Chunk receipt failed`);
        log(`Chunk receipt failed:\n${e.stack}`, stream);
        status = HTTP_STATUS_BAD_REQUEST;
    }

    respondAndEnd(stream, status);
}

function validatePatchHeaders(headers) {
    const contentLength = parseInt(headers[HTTP2_HEADER_CONTENT_LENGTH]);
    const uploadID = headers["00uploadid"];
    const guid = headers["00guid"];
    const uploadObj = g_uploadInfos[uploadID];
    const fileID = headers["00fileid"];
    const fileSize = parseInt(headers["00filesize"]);
    let error = null;
    let fileName = "";
    
    try {
        fileName = decodeURIComponent(Buffer.from(headers["00filename"], "base64"));
    }
    catch (e) { 
        error = new Error("Failed to parse file name header");
    }
    
    if (!uploadID || !fileName || !guid || 
        !isFinite(contentLength) || !isFinite(fileSize)) {
        error = new Error("Invalid parameter");
    }
    else if (!uploadObj) {
        error = new Error("Requested upload that doesn't exist");
    }
    else if (guid !== uploadObj.owner) {
        error = new Error(
            `Incorrect owner ${guid} for given upload ID ${uploadID}`);
    }

    if (error) {
        throw error;
    }

    return {contentLength, fileName, guid, uploadObj, fileID, fileSize};
}

async function processFileChunk(uploadObj, fileObj, chunk) {
    uploadObj.received += chunk.length;
    fileObj.received += chunk.length;



    if (fileObj.received > fileObj.size) {
        throw new Error("File size exceeded");
    }
    else if (uploadObj.received > uploadObj.size) {
        throw new Error("Upload size exceeded");
    }
    else {
        if (!DEBUG_simulateWrites) {
            if (fileObj.received === fileObj.size) {
                if (fileObj.backpressurePromise) {
                    await fileObj.backpressurePromise;
                }

                const streamReady = fileObj.writeStream.write(chunk, null, 
                    () => fileComplete(uploadObj, fileObj));

                if (!streamReady) {
                    console.log("waiting for drain event");
                    fileObj.backpressurePromise = (new Promise(resolve => 
                        fileObj.writeStream.once("drain", resolve))).then(() => fileObj.backpressurePromise = null);
                }

            }
            else {
                fileObj.writeStream.write(chunk);
            }
        }
        else {
            const p = new Promise(resolve => setTimeout(resolve, DEBUG_writeTime));

            if (fileObj.received === fileObj.size) {
                p.then(() => fileComplete(uploadObj, fileObj));
            }
        }
    }
}

function receiveFileData(stream, uploadObj, fileObj) {
    return new Promise((resolve, reject) => {
        stream.on("data", chunk => processFileChunk(uploadObj, fileObj, chunk));
        stream.on("end",  resolve);
        stream.on("error", reject);
    });
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
            respondAndEnd(stream, HTTP_STATUS_TEMPORARY_REDIRECT, 
                null, {"Location": "/"});
        }
        else {
            send404(stream);
        }
    }
    else if (path1Lower in g_uploadInfos) {
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

function handleInfoRequest(stream, headers) {
    const uploadID = headers["00uploadid"];
    const guid = headers.cookie;
    const uploadObj = g_uploadInfos[uploadID];
    let valid = false;

    if (uploadObj && uploadObj.owner === guid) {
        const files = uploadObj.files;

        if (files) {
            const fileList = Object.values(files).map((fileObj) =>
                [fileObj.id, fileObj.received, fileObj.size]);
            respondAndEnd(stream, HTTP_STATUS_OK, JSON.stringify(fileList));
            valid = true;
        }
    }
    
    if (!valid) {
        respondAndEnd(stream, HTTP_STATUS_NOT_FOUND);
    }
}

async function saveSession() {
    const sessionObj = {};

    for (const [uid, {owner, completeTime}] of Object.entries(g_uploadInfos)) {
        if (completeTime) {
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
                    g_uploadInfos[uid] = {owner, completeTime};
                    
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

    // Purge all upload folders that weren't included in the session file
    try {
        const uploads = await fsp.readdir(`${__dirname}/uploads`);

        for (const entryName of uploads) {
            if (entryName !== "session.json" && !(entryName in g_uploadInfos)) {
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
        "PATCH": handlePatchRequest,
        "INFO" : handleInfoRequest,
    };

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
