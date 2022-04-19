const http2 = require("http2");
const http = require("http");
const fsp = require("fs/promises");
const fs = require("fs");

const DEBUG_verbose = true;
// Don't actually save the uploaded data
const DEBUG_simulatedWrite = true;
// Time taken for simulated writes
const DEBUG_simulatedWriteSpeed = 0;

const c_charset = "abcdefghijklmnopqrstuvwxyz";
const c_idLength = 6;
const c_chunkSize = 1024 * 256; //256kb
const c_maxTimeBetweenData = 1000 * 2; //30s
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
    HTTP_STATUS_PAYLOAD_TOO_LARGE,
    HTTP_STATUS_CREATED
} = http2.constants;

const g_writePromises = {};
const g_writeQueues = {};

//generate an ID of random letters in mixed case
function generateID() {
    let id = "";

    for (let i = 0; i < c_idLength; ++i) {
        id += c_charset[Math.floor(Math.random() * c_charset.length)];
    }

    return id;
}

function log(stream, message) {
    const address = stream.session.socket.remoteAddress;
    console.log(`[${address}] ${message}`);
}

//keeps generating IDs until a new one is found
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
async function sendFile(stream, path) {
    const data = await fsp.readFile(`${__dirname}/${path}`);
    respondAndEnd(stream, HTTP_STATUS_OK, data);
}

async function send404(stream) {
    const data = await fsp.readFile(`${__dirname}/site/404.html`);
    respondAndEnd(stream, HTTP_STATUS_NOT_FOUND, data);
}

async function sendFileListPage(stream, uid) {
    const fileNames = await fsp.readdir(`${__dirname}/uploads/${uid}`);
    const fileListHTML = fileNames.map(fileName => {
        return `<a href="/${uid}/${encodeURI(fileName)}" class="fileTracker download" download><p class="fileName">${fileName}</p></a>`;
    }).join("\r\n");

    const template = await fsp.readFile(`${__dirname}/site/fileList.html`);
    const response = template.toString()
        .replace("{FILE_LIST}", fileListHTML)
        .replace("PHILE_CREATE", g_uploadInfos[uid].completeTime)
        .replace("PHILE_UPLOAD_DURATION", c_expiryTime);

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
        
        if (DEBUG_verbose) {
            log(stream, `SENDING ${uid}/${fileName}`);
        }
        const readStream = fs.createReadStream(filePath);
        readStream.pipe(stream);
        
        readStream.on("end", () => {
            log(stream, `SENT ${uid}/${fileName}`);
        });
    }
}

function setDeleteTimeout(uid, time = 0, reason = "DELETE") {
    const uploadInfo = g_uploadInfos[uid];
    if (!uploadInfo) {
        return;
    }

    clearTimeout(uploadInfo.deleteTimeout);
    uploadInfo.deleteTimeout = setTimeout(() => {
        console.log(`DELETE ${uid}: ${reason}`);
        console.log(JSON.stringify(uploadInfo, null, 2));
        
        for (const {fd} of Object.values(uploadInfo.files)) {
            if (fd) {
                fd.close();
            }
        }
        
        delete g_uploadInfos[uid];
        fsp.rm(`${__dirname}/uploads/${uid}`, {recursive: true})
            .catch(e => console.error(`Unable to delete ${uid}. ${e}`));
    }, time);
}

async function handleNewUploadRequest(stream, headers) {
    const uid = generateUniqueID();
    const totalSize = parseInt(headers["total-size"]);
    const guid = headers["guid"];

    if (!guid || !isFinite(totalSize)) {
        respondAndEnd(stream, HTTP_STATUS_BAD_REQUEST);
        return;
    }

    log(stream, `NEW ${uid} [${totalSize}]`);

    g_uploadInfos[uid] = {
        files: {},
        owner: guid,
        totalSize,
        received: 0,
        written: 0,
        complete: false
    };

    setDeleteTimeout(uid, c_maxTimeBetweenData, "MAX TIME SINCE NEW");

    await fsp.mkdir(`${__dirname}/uploads/${uid}`, {recursive: true});
    respondAndEnd(stream, HTTP_STATUS_CREATED, `${uid}/${c_chunkSize}`);
}

function receiveFileChunk(stream, headers) {
    return new Promise((resolve, reject) => {
        const contentLength = Math.min(headers[HTTP2_HEADER_CONTENT_LENGTH], c_chunkSize);
        const bufferSize = isFinite(contentLength) ? contentLength : c_chunkSize;

        const data = Buffer.alloc(bufferSize);
        let bytesReceived = 0;
    
        stream.on("error", e => {
            reject(e);
        });
        
        stream.on("data", chunk => {
            bytesReceived += chunk.copy(data, bytesReceived);
        });
        
        stream.on("end", () => {
            resolve(data);
        });
    });
}

function validateDataRequest(stream, headers) {
    const contentLength = headers[HTTP2_HEADER_CONTENT_LENGTH];
    const uploadId = headers["upload-id"];
    const offset = parseInt(headers["offset"]);
    const guid = headers["guid"];
    const uploadObj = g_uploadInfos[uploadId];

    let fileName = "";
    let valid = false;
    
    try {
        fileName = decodeURIComponent(Buffer.from(headers["file-name"], "base64"));
        valid = true;
    }
    catch (e) { console.error("Failed to parse file-name header") }
    
    if (!uploadId || !fileName || !isFinite(offset) || !guid) {
        respondAndEnd(stream, HTTP_STATUS_BAD_REQUEST);
    }
    else if (!uploadObj) {
        send404(stream);
    }
    else if (guid !== uploadObj.owner) {
        respondAndEnd(stream, HTTP_STATUS_NOT_AUTHORIZED);
    }
    else {
        valid = true;
    }
    
    return valid ? {contentLength, uploadId, fileName, offset, guid, uploadObj} : null;
}

async function writeChunk(chunkInfo) {
    const {uploadId, uploadObj, 
        fileObj, chunkData, 
        offset} = chunkInfo;

    if (uploadObj.received > uploadObj.totalSize || 
        fileObj.written > fileObj.size) {
        setDeleteTimeout(uploadId, 0, "EXCEEDED");
    }
    else {
        if (DEBUG_simulatedWrite) {
            const sleep = ms => new Promise(r => setTimeout(r, ms));
            await sleep(DEBUG_simulatedWriteSpeed);
        }
        else {
            await fileObj.fd.write(chunkData, 0, chunkData.length, offset);
        }
        
        fileObj.written += chunkData.length;
        uploadObj.written += chunkData.length;
        
        if (fileObj.written >= fileObj.size) {
            if (fileObj.written === fileObj.size) {
                console.log(`RECEIVED ${uploadId}/${fileObj.name}`);
                fileObj.fd.close();
                fileObj.fd = null;
            }
            else {
                console.log(typeof fileObj.written, typeof fileObj.size);
                setDeleteTimeout(uploadId, 0, `Received too many bytes for file ${fileObj.name} [${fileObj.written}/${fileObj.size}]`);
            }
        }
        
        if (uploadObj.written === uploadObj.totalSize) {
            console.log(`COMPLETE ${uploadId}`);
            uploadObj.complete = true;
            uploadObj.completeTime = Date.now();
            saveSession();
            setDeleteTimeout(uploadId, c_expiryTime, "EXPIRE");
        }
    }
}

// Writes the first item in the queue for that file
// then checks for another item. Repeats until the queue
// is empty. This is because we shouldn't call fsp.write
// again for a given file until the previous promise is
// resolved.
async function writeAllQueue(fileName) {
    let nextObj = g_writeQueues[fileName].shift();

    while (nextObj) {
        await writeChunk(nextObj);
        nextObj = g_writeQueues[fileName].shift();
    }

    delete g_writePromises[fileName];
}

async function handleDataRequest(stream, headers) {
    const requestInfo = validateDataRequest(stream, headers);

    if (!requestInfo) {
        return;
    }

    const {
        contentLength, uploadId, 
        fileName, offset, uploadObj
    } = requestInfo;
    
    if (DEBUG_verbose) {
        //log(stream, `DATA ${uploadId}/${fileName} O:${offset} L:${contentLength}`);
    }

    setDeleteTimeout(uploadId, c_maxTimeBetweenData, "MAX DATA INTERVAL");

    let fileObj = uploadObj.files[fileName];
    
    if (!fileObj) {
        fileObj = {
            written: 0,
            size: parseInt(headers["file-size"]),
            fd: null,
            name: fileName
        };
        
        if (DEBUG_verbose) {
            log(stream, `FILE ${uploadId}/${fileObj.name}[${fileObj.size}]`);
        }

        uploadObj.files[fileName] = fileObj;

        const dirPath = `${__dirname}/uploads/${uploadId}`;
        if (DEBUG_verbose) {
            log(stream, `OPEN ${uploadId}/${fileName}`);
        }

        fileObj.fdPromise = fsp.open(`${dirPath}/${fileName}`, "wx");
    }
    
    const chunkData = await receiveFileChunk(stream, headers);
    uploadObj.received += chunkData.length;

    respondAndEnd(stream, HTTP_STATUS_OK, null);

    // ensure all data requests wait for file to be ready for write
    fileObj.fd = await fileObj.fdPromise;
    const chunkInfo = {stream, uploadId, 
        uploadObj, fileObj, chunkData, offset};

    // Add the data to a file specific queue
    if (!g_writeQueues[fileName]) {
        g_writeQueues[fileName] = [chunkInfo];
    }
    else {
        g_writeQueues[fileName].push(chunkInfo);
    }

    // if it isn't already running, start a promise to
    // write everything in the queue, else do nothing as
    // the currently running promise will write this data
    if (!g_writePromises[fileName]) {
        g_writePromises[fileName] = writeAllQueue(fileName)
            .catch(e => console.error("Error in write promise: ", e));
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
    else if (Object.keys(g_uploadInfos).includes(path1Lower)) {
        if (path2) {
            sendUploadFile(stream, path1Lower, decodeURI(path2));
        }
        else {
            sendFileListPage(stream, path1);
        }
    }
    else {
        send404(stream);
    }
}

async function saveSession() {
    const sessionObj = {};

    for (const uid in g_uploadInfos) {
        const {owner, complete, completeTime} = g_uploadInfos[uid];

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

    if (DEBUG_verbose) {
        //log(stream, `${method} ${headers[HTTP2_HEADER_PATH]}`);
    }

    stream.on("error", e => {
        log(stream, "Network error: " + e);
    });

    switch(method) {
        case "GET":
            handleFileRequest(stream, headers);
            break;

        case "POST":
            handleNewUploadRequest(stream, headers);
            break;

        case "PATCH":
            handleDataRequest(stream, headers);
            break;

        default:
            log(stream, "NO HANDLER");
            respondAndEnd(stream, HTTP_STATUS_BAD_REQUEST);
    }
});

recover().then(() => {
    server.listen(options, () => {
        console.log(`Listening on ${options.port}`);
    });
});

// https redirect server
const redirectServer = http.createServer((req, res) => {
    res.writeHead(301, {
        "Location": `https://${req.headers.host}${req.url}`
    });
    res.end();
});

redirectServer.listen(42080);
