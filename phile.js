const http = require("http");
const fs = require("fs");

//num of chars to use in each ID
const ID_LENGTH = 8;
//time before file automatically deleted
const AUTO_DELETE_TIMEOUT = 1000 * 60 * 60 * 24;

//filter for ignoring certain user agents
const uaFilter = /(facebook|discord)/;

const fileInfo = {};
const pendingUploads = {};


//generate an ID of random letters in mixed case
function generateID() {
    let id = "";

    for (let i = 0; i < ID_LENGTH; ++i) {
        let charCode = 0x41 + Math.floor(Math.random() * 26);
        if (Math.random() < 0.5) {
            charCode += 32;
        }
        id += String.fromCharCode(charCode);
    }

    return id;
}


//keeps generating IDs until a new one is found
function generateUniqueID() {
    let id;

    do {
        id = generateID();
    } while (fileInfo[id] !== undefined);

    return id;
}


//send a file normally to the user
function sendFile(res, path) {
    fs.readFile(`${__dirname}/${path}`, (err, data) => {
        if (err) {
            send404(res);
        }
        else {
            res.end(data);
        }
    });
}


function send404(res) {
    res.writeHead(404, "File not found.");

    fs.readFile(__dirname + "/site/404.html", (err, data) => {
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
    if (fileInfo[id] !== undefined) {
        const filename = fileInfo[id].filename;
        const filePath = `${__dirname}/files/${id}`;
        
        res.writeHead(200, {
            "Content-Length": fs.statSync(filePath).size,
            "Content-Disposition": `attachment; filename="${filename}"`
        });
        
        const readStream = fs.createReadStream(filePath);
        readStream.pipe(res);
        
        readStream.on("end", () => {
            const info = fileInfo[id];

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


function deleteFile(id) {
    if (fileInfo[id]) {
        fs.unlink(`${__dirname}/files/${id}`, err => {
            if (err) {
                console.log("Error deleting " + id);
            }
            else {
                console.log("Deleted " + id);
            }
        });

        delete fileInfo[id];
        delete pendingUploads[id];
    }
}


//parse the number of downloads
//defaults to 1, only accepts numbers
//greater than 0
function parseDCount(numString) {
    const parsed = parseInt(numString);
    
    let n = 1;
    if (!isNaN(parsed) && parsed > 0)
    {
        n = parsed;
    }

    return n;
}


function handleGET(req, res) {
    if (req.url === "/") {
        sendFile(res, "site/index.html");
    }
    else {
        let path = req.url.split("?")[0];

        //prevent simple directory traversal
        if (path.includes("..")) {
            const regex = /\/\.\./g;
            path = path.replace(regex, "");
        }

        path = path.substr(1);
        
        if (fileInfo[path])
        {      
            sendFileID(res, path);
        }
        else
        {
            sendFile(res, `site/${path}`);
        }
    }
}


function handlePOST(req, res) {
    if (req.url === "/new") {
        const size = parseInt(req.headers["x-filesize"]);

        if (!isNaN(size)) {
            const id = generateUniqueID();
            
            fs.open(`${__dirname}/files/${id}`, "w", (err, fd) => {
                if (err) {
                    res.writeHead(500);
                }
                else {
                    pendingUploads[id] = {fd, id, size, received: 0, lastPromise: null};
                    fileInfo[id] = {
                        filename: req.headers["x-filename"],
                        dCount: parseDCount(req.headers["x-dcount"])
                    };
        
                    console.log(`NEW ${req.connection.remoteAddress} (ID: ${id}, size: ${size}, dcount: ${fileInfo[id].dCount})`);
                    res.writeHead(200, {"X-File-ID": id});
                }
                res.end();
            });
        }
        else {
            res.writeHead(500);
            res.end();
        }
    }
    else if (req.url === "/data") {
        const id = req.headers["x-file-id"];
        const pending = pendingUploads[id];
        
        if (pending) {
            const blockSize = parseInt(req.headers["content-length"]);

            if (isNaN(blockSize)) {
                res.writeHead(500);
                res.end();
                return;
            }

            const data = Buffer.alloc(blockSize);
            let bytesReceived = 0;
            
            req.on("data", chunk => {
                chunk.copy(data, bytesReceived, 0);
                bytesReceived += chunk.length;
            });
            
            req.on("end", () => {
                //make a copy of the number of bytes that will have been written
                //once this write is complete. Using pending.received in the callback
                //would not be correct after all data is received but not yet written.
                const total = pending.received + bytesReceived;
                pending.received = total;

                const writeData = (resolve, reject) => {
                    const startByte = parseInt(req.headers["x-start"]);

                    if (isNaN(startByte)) {
                        res.writeHead(500);
                        res.end();
                        reject();
                    }
                    else {
                        fs.write(pending.fd, data, 0, data.length, startByte, err => {
                            if (err) {
                                res.writeHead(500);
                                reject();
                            }
                            else {
                                res.writeHead(200, {"X-Received": total});
                                resolve();
                            }
    
                            res.end();
                        });
                    }
                };

                if(pending.lastPromise) {
                    pending.lastPromise = new Promise((resolve, reject) => {
                        pending.lastPromise.then(() => {
                            writeData(resolve, reject);
                        });
                    });
                }
                else {
                    pending.lastPromise = new Promise(writeData);
                }

                if (pending.received > pending.size) {
                    pending.lastPromise.then(() => {
                        fs.close(pending.fd);
                        delete pendingUploads[id];
                        setTimeout(() => {
                            deleteFile(id);
                        }, AUTO_DELETE_TIMEOUT);
                    });
                }
            });
        }
        else {
            console.log("Data sent to /data with no pending upload at ID " + id);
        }
    }

}


const server = http.createServer((req, res) => {
    const ua = req.headers["user-agent"];

    //ignore requests with a user agent
    //matching the filter rules
    if (!uaFilter.test(ua))
    {
        if (req.method === "GET")
        {
            handleGET(req, res);
        }
        else if (req.method === "POST")
        {
            handlePOST(req, res);
        }
    }
    else
    {
        console.log("Filtered UA");
        //send response to filtered agents
        //so they know not to retry
        res.writeHead(403, "Filtered UA");
        res.end();
    }
});


const options = {
    port: 1880,
    host: "0.0.0.0"
}

const filesDir = __dirname + "/files";

if (!fs.existsSync(filesDir)) {
    fs.mkdirSync(filesDir);
}

server.listen(options, () => {
    console.log(`Listening on ${options.port}`);
});
