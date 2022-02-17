const http2 = require("http2");
const fsp = require("fs/promises");
const fs = require("fs");

const c_alphabet = "abcdefghijklmnopqrstuvwxyz";
const c_charset = `${c_alphabet}${c_alphabet.toUpperCase()}0123456789_`;
const c_idLength = 4;
const c_chunkSize = 1024 ** 2 * 128; //128Mb
const c_maxTimeBetweenData = 1000 * 30; //30s
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

let g_writePromise = Promise.resolve();

//generate an ID of random letters in mixed case
function generateID() {
    let id = "";

    for (let i = 0; i < c_idLength; ++i) {
        id += c_charset[Math.floor(Math.random() * c_charset.length)];
    }

    return id;
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

    stream.respond(headers);
    stream.end(endData);
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
        return `<a href="/${uid}/${encodeURI(fileName)}" class="fileTracker"><p class="fileName">${fileName}</p></a>`;
    }).join("\r\n");

    const template = await fsp.readFile(`${__dirname}/site/fileList.html`);
    const response = template.toString().replace("{FILE_LIST}", fileListHTML);

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
    
    stream.respond({
        [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
        "content-length": fileInfo.size,
        "content-disposition": `attachment; filename="${fileName}"`
    });
    
    console.log(`SENDING ${uid}/${fileName}`);
    const readStream = fs.createReadStream(filePath);
    readStream.pipe(stream);
    
    readStream.on("end", () => {
        console.log(`SENT ${uid}/${fileName}`);
    });
}

function setDeleteTimeout(uid, time = 0, reason = "DELETE") {
    if (!g_uploadInfos[uid]) {
        return;
    }

    clearTimeout(g_uploadInfos[uid].deleteTimeout);
    g_uploadInfos[uid].deleteTimeout = setTimeout(() => {
        console.log(`${reason} ${uid}`);
        delete g_uploadInfos[uid];
        fsp.rm(`${__dirname}/uploads/${uid}`, {recursive: true});
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

    console.log(`NEW ${uid} [${totalSize}]`);

    g_uploadInfos[uid] = {
        files: {},
        owner: guid,
        totalSize,
        received: 0,
        complete: false
    };

    setDeleteTimeout(uid, c_maxTimeBetweenData, "FAIL");

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
    const fileName = headers["file-name"];
    const offset = parseInt(headers["offset"]);
    const guid = headers["guid"];
    const uploadObj = g_uploadInfos[uploadId];
    let valid = true;
    
    if (!uploadId || !fileName || !isFinite(offset) || !guid) {
        respondAndEnd(stream, HTTP_STATUS_BAD_REQUEST);
        valid = false;
    }
    
    if (!uploadObj) {
        send404(stream);
        valid = false;
    }

    if (guid !== uploadObj.owner) {
        respondAndEnd(stream, HTTP_STATUS_NOT_AUTHORIZED);
        valid = false;
    }

    if (uploadObj.received >= uploadObj.totalSize) {
        respondAndEnd(stream, HTTP_STATUS_PAYLOAD_TOO_LARGE);
        valid = false;
    }
    
    console.log(`DATA REQUEST ${valid ? "VALID" : "INVALID"}`);

    if (!valid) {
        return null;
    }

    return {contentLength, uploadId, fileName, offset, guid, uploadObj}
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
    console.log(`DATA ${uploadId}/${fileName} [${offset} - ${contentLength}]`);

    setDeleteTimeout(uploadId, c_maxTimeBetweenData, "FAIL");

    let fileObj = uploadObj.files[fileName];
    
    if (!fileObj) {
        fileObj = {
            received: 0,
            size: headers["file-size"],
            fd: null,
            name: fileName
        };
        uploadObj.files[fileName] = fileObj;

        const dirPath = `${__dirname}/uploads/${uploadId}`;
        console.log(`OPEN ${uploadId}/${fileName}`);
        fileObj.fdPromise = fsp.open(`${dirPath}/${fileName}`, "wx");
    }
    
    // ensure all data request wait for file to be ready for write
    fileObj.fd = await fileObj.fdPromise;

    const chunkData = await receiveFileChunk(stream, headers);

    g_writePromise = g_writePromise.then(async () => {
        uploadObj.received += chunkData.length;
        fileObj.received += chunkData.length;


        if (uploadObj.received > uploadObj.totalSize || 
            fileObj.received > fileObj.size) {
            respondAndEnd(stream, HTTP_STATUS_PAYLOAD_TOO_LARGE);
            setDeleteTimeout(uploadId, 0, "EXCEEDED");
        }
        else {
            const uploadComplete = uploadObj.received === uploadObj.totalSize;
            await fileObj.fd.write(chunkData, 0, chunkData.length, offset);
            
            if (fileObj.received >= fileObj.size) {
                console.log(`FIN ${fileObj.name}`);
                fileObj.fd.close();
                fileObj.fd = null;
            }
            
            if (uploadComplete) {
                console.log(`COMPLETE ${uploadId}`);
                uploadObj.complete = true;
                uploadObj.completeTime = Date.now();
                saveSession();
                setDeleteTimeout(uploadId, c_expiryTime, "EXPIRE");
            }
    
            respondAndEnd(stream, HTTP_STATUS_OK, null, {
                "received": fileObj.received,
            });
        }
    }).catch(e => {
        console.log("Error in promise chain\n", e);
    });
}

function handleFileRequest(stream, headers) {
    const allowedFiles = ["index.html", "main.css", "main.js"];
    const [path1, path2] = headers[HTTP2_HEADER_PATH].substring(1).split("/");

    if (path1.length === 0) {
        sendFile(stream, "site/index.html");
    }
    else if (allowedFiles.includes(path1)) {
        sendFile(stream, `site/${path1}`);
    }
    else if (Object.keys(g_uploadInfos).includes(path1)) {
        if (path2) {
            sendUploadFile(stream, path1, decodeURI(path2));
        }
        else {
            sendFileListPage(stream, path1);
        }
    }
    else {
        send404(stream);
    }
}

function saveSession() {
    const sessionObj = {};

    for (const uid in g_uploadInfos) {
        const {owner, complete, completeTime} = g_uploadInfos[uid];

        if (complete) {
            sessionObj[uid] = {owner, completeTime};
        }
    }

    fsp.writeFile(`${__dirname}/uploads/session.json`, JSON.stringify(sessionObj));
}

// Restores uploads from the previous
// session if they are still valid
async function recover() {
    try {
        const text = fs.readFileSync(`${__dirname}/uploads/session.json`).toString();
        
        try {
            const session = JSON.parse(text);

            for (const uid in session) {
                const {owner, completeTime} = session[uid];

                if (owner && completeTime) {
                    console.log(`RESTORE ${uid} [${remainingTime}]`);

                    g_uploadInfos[uid] = {owner, completeTime};
                    
                    const timeDiff = Date.now() - completeTime;
                    const remainingTime = c_expiryTime - timeDiff;
    
                    setDeleteTimeout(uid, remainingTime, "EXPIRE");
                }
            }
        }
        catch {
            console.error("Failed to parse session file");
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

    console.log(`${method} ${headers[HTTP2_HEADER_PATH]}`);

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
            console.log("NO HANDLER");
    }
});

recover().then(() => {
    server.listen(options, () => {
        console.log(`Listening on ${options.port}`);
    });
});
