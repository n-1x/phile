const http2 = require("http2");
const fsp = require("fs/promises");
const fs = require("fs");

const c_alphabet = "abcdefghijklmnopqrstuvwxyz";
const c_charset = `${c_alphabet}${c_alphabet.toUpperCase()}0123456789_`;
const c_idLength = 4;
const c_chunkSize = 1024 ** 2 * 128; //128Mb

const uploadInfo = {};
const pendingUploads = {};

const {
    HTTP2_HEADER_METHOD,
    HTTP2_HEADER_PATH,
    HTTP2_HEADER_CONTENT_LENGTH
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
    } while (uploadInfo[id] !== undefined);

    return id;
}

//send a file normally to the user
async function sendFile(stream, path) {
    const data = await fsp.readFile(`${__dirname}/${path}`);
    stream.respond({
        ":status": 200
    });
    stream.end(data);
}

function send404(stream) {
    stream.respond({":status": 404});

    fsp.readFile(__dirname + "/site/404.html", (err, data) => {
        if (err) {
            console.error("Couldn't load 404 file: " + err);
        }
        else {
            stream.end(data);
        }
    });
}

//sends the file with the given ID to the user
//with a header to have the browser offer to save
//it instead of trying to render it
function sendFileID(stream, id) {
    if (uploadInfo[id] !== undefined) {
        const filename = uploadInfo[id].filename;
        const filePath = `${__dirname}/files/${id}`;
        
        stream.writeHead(200, {
            "Content-Length": fsp.statSync(filePath).size,
            "Content-Disposition": `attachment; filename="${filename}"`
        });
        
        const readStream = fs.createReadStream(filePath);
        readStream.pipe(stream);
        
        readStream.on("end", () => {
            const info = uploadInfo[id];

            --info.dCount;
            console.log(`Sent ${id}[${info.dCount}]`);  

            if (info.dCount === 0) {
                deleteFile(id);
            }
        });
    }
    else {
        send404(stream);
    }
}

function handleNewUploadRequest(stream, headers) {
    const uid = generateUniqueID();

    console.log(`NEW ${uid}`);

    pendingUploads[uid] = {
        files: {},
        owner: headers["guid"],
    };
    
    stream.respond({":status": 200});
    stream.end(`${uid}/${c_chunkSize}`);    
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

async function handleDataRequest(stream, headers) {
    const contentLength = headers[HTTP2_HEADER_CONTENT_LENGTH];
    const uploadId = headers["upload-id"];
    const fileName = headers["file-name"];
    const offset = headers["offset"];
    const uploadObj = pendingUploads[uploadId];

    console.log(`DATA ${uploadId}/${fileName} [S: ${offset}, E: ${contentLength}]`);
    
    if (!uploadObj || headers["guid"] !== uploadObj.owner) {
        send404(stream);
        return;
    }
    
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

        fileObj.fdPromise = fsp.mkdir(dirPath, {recursive: true}).then(() => {
            return fsp.open(`${dirPath}/${fileName}`, "wx");
        });
    }
    
    fileObj.fd = await fileObj.fdPromise;

    receiveFileChunk(stream, headers).then(chunkData => {
        g_writePromise = g_writePromise.then(async () => {
            await fileObj.fd.write(chunkData, 0, chunkData.length, offset);

            fileObj.received += chunkData.length;
            stream.respond({
                ":status": 200,
                "received": fileObj.received
            });
            stream.end();

            if (fileObj.received >= fileObj.size) {
                console.log(`FIN ${fileObj.name}`);
                fileObj.fd.close();
                fileObj.fd = null;
            }
        }).catch(e => {
            console.log("Error in promise chain\n", e);
        });
    });
}

function handleFileRequest(stream, headers) {
    const allowedFiles = ["index.html", "main.css", "main.js"];
    const path = headers[HTTP2_HEADER_PATH].substring(1);

    if (path === "") {
        sendFile(stream, "site/index.html");
    }
    else if (allowedFiles.includes(path)) {
        sendFile(stream, `site/${path}`);
    }
    else if (Object.keys(pendingUploads).includes(path)) {
        console.log("TODO, sending actual download page");
    }
    else {
        send404(stream);
    }
}

const options = {
    port: 1880,
    host: "0.0.0.0",
    key: fs.readFileSync("localhost-privkey.pem"),
    cert: fs.readFileSync("localhost-cert.pem"),
};

const server = http2.createSecureServer(options);
server.on("error", e => console.error(e));

server.on("stream", (stream, headers) => {
    const method = headers[HTTP2_HEADER_METHOD];

    if (method === "GET")
    {
        handleFileRequest(stream, headers);
    }
    else if (method === "POST")
    {
        handleNewUploadRequest(stream, headers);
    }
    else if (method === "PATCH")
    {
        handleDataRequest(stream, headers);
    }
});

server.listen(options, () => {
    console.log(`Listening on ${options.port}`);
});