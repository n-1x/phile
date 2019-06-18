const http = require("http");
const fs = require("fs");

//num of chars to use in each ID
const ID_LENGTH = 8;
//time before file automatically deleted
const AUTO_DELETE_TIMEOUT = 1000 * 60 * 60 * 24;

//filter for ignoring certain user agents
const uaFilter = /(facebook|discord)/;
const fileInfo = {};


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
    fs.readFile(path, (err, data) => {
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

    fs.readFile("site/404.html", (err, data) => {
        if (err) {
            console.error("Couldn't load 404 file");
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
        const filePath = "./files/" + id;

        res.writeHead(200, {
            "Content-Length": fs.statSync(filePath).size,
            "Content-Disposition": `attachment; filename="${filename}"`
        });

        const readStream = fs.createReadStream(filePath);
        readStream.pipe(res);
    }
    else {
        send404(res);
    }
}


function deleteFile(id) {
    if (fileInfo[id] !== undefined) {
        fs.unlink("./files/" + id, err => {
            if (err) {
                console.log("Error deleting " + id);
            }
            else {
                console.log("Deleted " + id);
            }
        });

        fileInfo[id] = undefined;
    }
}


//parse the number of downloads
//defaults to 1, only accepts numbers
//greater than 0
function parseDCount(numString) {
    let n = 1;
    
    if (numString !== "")
    {
        let parsed = parseInt(numString);

        if (!isNaN(parsed) && parsed > 0)
        {
            n = parsed;
        }
    }

    return n;
}


function handleGET(req, res) {
    if (req.url === "/") {
        sendFile(res, "site/index.html");
    }
    else if (req.url.includes(".")) {
        //prevent simple directory traversal
        const regex = /\/\.\./g;
        const path = req.url.replace(regex, "");
        sendFile(res, "site/" + path.substr(1));
    }
    else {
        const id = req.url.substr(1);
        
        if (fileInfo[id])
        {
            sendFileID(res, id);
            --fileInfo[id].dCount;
            console.log(`Sent ${id}[${fileInfo[id].dCount}]`);

            if (fileInfo[id].dCount === 0)
            {
                deleteFile(id);
            }            
        }
        else
        {
            send404(res);
        }
    }
}


function handlePOST(req, res) {
    const id = generateUniqueID();
    const writeStream = fs.createWriteStream("./files/" + id);
    const fileSize = req.headers["content-length"];
    let bytesWritten = 0;

    req.on("data", chunk => {
        writeStream.write(chunk, err => {
            if (err) {
                console.log("Error writing chunk: " + err);
                res.writeHead(500);
                res.end();
            }
            else {
                bytesWritten += chunk.length;
                
                //handle response here so the ID is only sent
                //when the file is fully written to disk. This
                //means the link will be immediately usable
                if (bytesWritten >= fileSize) {
                    writeStream.end();
                    const dCount = parseDCount(
                        req.headers["x-dcount"]);
        
                    fileInfo[id] = {
                        filename: req.headers["x-filename"],
                        dCount
                    };

                    res.writeHead(200, {"X-File-ID": id});
                    res.end();
                    console.log("Received " + id);

                    setTimeout(deleteFile, AUTO_DELETE_TIMEOUT, id);
                }
            }
        });
    });
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

server.listen(options, () => {
    console.log(`Listening on ${options.port}`);
});