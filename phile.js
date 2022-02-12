const http = require("http");
const fsp = require("fs/promises");
const fs = require("fs");

const c_alphabet = "abcdefghijklmnopqrstuvwxyz";
const c_charset = `${c_alphabet}${c_alphabet.toUpperCase()}0123456789_`;
const c_idLength = 4;
const c_chunkSize = 1024 ** 2 * 128; //128Mb

const uploadInfo = {};
const pendingUploads = {};

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
async function sendFile(res, path) {
    const data = await fsp.readFile(`${__dirname}/${path}`);
    res.writeHead(200);
    res.end(data);
}

function send404(res) {
    res.writeHead(404, "File not found.");

    fsp.readFile(__dirname + "/site/404.html", (err, data) => {
        if (err) {
            console.error("Couldn't load 404 file: " + err);
        }
        else {
            res.end(data);
        }
    });
}

//sends the file with the given ID to the user
//with a header to have the browser offer to save
//it instead of trying to render it
function sendFileID(res, id) {
    if (uploadInfo[id] !== undefined) {
        const filename = uploadInfo[id].filename;
        const filePath = `${__dirname}/files/${id}`;
        
        res.writeHead(200, {
            "Content-Length": fsp.statSync(filePath).size,
            "Content-Disposition": `attachment; filename="${filename}"`
        });
        
        const readStream = fs.createReadStream(filePath);
        readStream.pipe(res);
        
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
        send404(res);
    }
}

function handleNewUploadRequest(req, res) {
    const uid = generateUniqueID();

    console.log(`NEW ${uid}`);
    pendingUploads[uid] = {
        files: {},
        owner: req.headers["guid"],
    };
    
    res.writeHead(200);
    res.end(`${uid}/${c_chunkSize}`);    
}

function receiveFileChunk(req) {
    return new Promise((resolve, reject) => {
        const contentLength = Math.min(req.headers["content-length"], c_chunkSize) || c_chunkSize;
        const data = Buffer.alloc(contentLength);
        let bytesReceived = 0;
    
        req.on("error", e => {
            reject(e);
        });
        
        req.on("data", chunk => {
            bytesReceived += chunk.copy(data, bytesReceived);
        });
        
        req.on("end", () => {
            resolve(data);
        });
    });
}

async function handleDataRequest(req, res) {
    const uploadId = req.headers["upload-id"];
    const fileName = req.headers["file-name"];
    const offset = req.headers["offset"];
    const uploadObj = pendingUploads[uploadId];

    console.log(`DATA ${uploadId}/${fileName} [S: ${offset}]`);
    
    if (!uploadObj || req.headers["guid"] !== uploadObj.owner) {
        res.writeHead(400);
        res.end();
        return;
    }
    
    let fileObj = uploadObj.files[fileName];
    
    if (!fileObj) {
        fileObj = {
            received: 0,
            size: req.headers["file-size"],
            fd: null
        };
        uploadObj.files[fileName] = fileObj;
        const dirPath = `${__dirname}/uploads/${uploadId}`;

        fileObj.fdPromise = fsp.mkdir(dirPath, {recursive: true}).then(() => {
            return fsp.open(`${dirPath}/${fileName}`, "wx");
        });
    }
    
    fileObj.fd = await fileObj.fdPromise;

    receiveFileChunk(req).then(chunkData => {
        g_writePromise = g_writePromise.then(async () => {
            await fileObj.fd.write(chunkData, 0, chunkData.length, offset);
            fileObj.received += chunkData.length;
            res.writeHead(200, {"received": fileObj.received});
            res.end();

            if (fileObj.received >= fileObj.size) {
                fileObj.fd.close();
                fileObj.fd = null;
            }
        }).catch(e => {
            console.log("Error in promise chain\n", e);
        });
    });
}

function handleFileRequest(req, res) {
    const allowedFiles = ["index.html", "main.css", "main.js"];
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname.substring(1, url.pathname.length);

    if (path === "") {
        sendFile(res, "site/index.html");
    }
    else if (allowedFiles.includes(path)) {
        sendFile(res, `site/${path}`);
    }
    else if (Object.keys(pendingUploads).includes(path)) {
        console.log("TODO, sending actual download page");
    }
    else {
        send404(res);
    }
}

const server = http.createServer((req, res) => {
    if (req.method === "GET")
    {
        handleFileRequest(req, res);
    }
    else if (req.method === "POST")
    {
        handleNewUploadRequest(req, res);
    }
    else if (req.method === "PATCH")
    {
        handleDataRequest(req, res);
    }
});

const options = {
    port: 1880,
    host: "0.0.0.0"
}

server.listen(options, () => {
    console.log(`Listening on ${options.port}`);
});