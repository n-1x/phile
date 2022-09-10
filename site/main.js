const c_fileNameMaxDisplayLength = 24;
const c_maxAttempts = 16;
const c_maxChunkSize = 2 ** 20; // 1MiB

const g_keyStates = {};
const g_fileMap = {};

let container = null;
let g_guid = window.localStorage.getItem("guid");
let g_uploadID = null;
let g_uploadStarted = false;
let g_cumulativeSize = 0;
let g_totalBytesSent = 0;
let g_successCount = 0;
let g_InfoInterval = null;

function generateGuid() {
    let guid = 0n;

    for (let i = 0n; i < 8n; ++i) {
        guid |= BigInt(Math.floor(Math.random() * 256)) << (8n * i);
    }

    return BigInt.asUintN(64, guid).toString(16);
}

function cutName(name) {
    if (name.length <= c_fileNameMaxDisplayLength) {
        return name;
    }   

    return name.substr(0, c_fileNameMaxDisplayLength - 7 - 1) + "..." + name.substr(-7);
}

function lowestSquareAbove(x) {
    let answer = 1;

    while (answer ** 2 < x) {
        ++answer;
    }

    return answer;
}

function addUniqueFileNames(fileList) {
    Array.from(fileList).forEach(file => {
        g_fileMap[file.name.toLowerCase()] = file;
        file.bytesSent = 0;
    });
    updateFileNamesList();
}

function updateFileNamesList() {
    const nameElements = [];

    for (const fileName in g_fileMap) {
        const element = document.createElement("div");
        element.classList.add("fileTracker");

        const nameP = document.createElement("p");
        nameP.classList.add("fileName");
        nameP.innerText = cutName(fileName);

        element.appendChild(nameP);
        element.onclick = e => {
            if (!g_uploadStarted) {
                delete g_fileMap[fileName];
                element.remove();
            }
        };

        g_fileMap[fileName].listElement = element;
        nameElements.push(element);
    }

    fileList.replaceChildren(...nameElements);
    fileList.children[0].scrollIntoView();
}

function createProgressMatrix() {
    fileList.style.display = "none";

    const matrix = document.createElement("div");
    matrix.id = "progressMatrix";
    matrix.classList.add("progressMatrix");
    
    const numFiles = Object.values(g_fileMap).length;
    const gridSize = lowestSquareAbove(numFiles);
    const width = 100/gridSize;
    
    matrix.style.gridTemplateColumns = `repeat(auto-fill, ${width}%)`;
    
    for (let i = 0; i < numFiles; ++i) {
        const span = document.createElement("span");
        span.classList.add("matrix");
        span.style.backgroundColor = `transparent`;
        matrix.appendChild(span);
    }

    container.replaceChildren(matrix);
}

function updateFileProgress(index, sentBytes, size) {
    const progress = (sentBytes / size) * 100;
    progressMatrix.children[index].style.background = 
        `linear-gradient(to top, var(--accent) ${progress}%, black ${progress}%)`;
}

async function readIntoBuffer(buffer, streamReader) {
    let bytesRead = 0;

    while (bytesRead < buffer.byteLength) {
        const view = new Uint8Array(buffer, bytesRead, buffer.byteLength - bytesRead);
        const {value, done} = await streamReader.read(view);
        
        bytesRead += value.byteLength;
        buffer = value.buffer;

        if (done && bytesRead < buffer.byteLength) {
            console.error("Failed to fill buffer");
        }
    }

    return new Uint8Array(buffer, 0, bytesRead);
};

async function sendFile(file, index) {
    const stream = file.stream();
    const streamReader = stream.getReader({mode: "byob"});
    let success = true;
    let bytesSent = 0;
    
    while (bytesSent < file.size) {
        const buffer = new ArrayBuffer(Math.min(file.size - bytesSent, c_maxChunkSize));
        console.log("Reading into new buffer", buffer, "for file", file.name, "Sent bytes:", bytesSent, "/", file.size);
        const view  = await readIntoBuffer(buffer, streamReader);
        
        const response = await fetch(`/${g_uploadID}`, {
            method: "PATCH",
            headers: {
                "00uploadID": g_uploadID,
                "00fileID": index,
                "00fileSize": file.size,
                "00fileName": btoa(encodeURIComponent(file.name)),
                "00guid": g_guid,
            },
            body: view
        });
        
        bytesSent += view.byteLength;
        g_totalBytesSent += view.byteLength;
        document.title = `> ${Math.floor(g_totalBytesSent / g_cumulativeSize * 100)}% [${g_totalBytesSent}/${g_cumulativeSize}]`;
        success &&= response.ok;

        updateFileProgress(index, bytesSent, file.size);
    }

    success &&= bytesSent === file.size;

    if (success) {
        ++g_successCount;
        progressMatrix.children[index].style.background = "var(--accent)";
    }

    return success;
};

async function beginUpload() {
    if (g_uploadStarted || Object.values(g_fileMap).length === 0) {
        return;
    }

    fileList.style.display = "none";
    container.style.cursor = "auto";
    createProgressMatrix();

    g_uploadStarted = true;
    fileInput.disabled = true;

    Object.values(g_fileMap).forEach(({size}) => g_cumulativeSize += size);

    g_uploadID = (await (await fetch("/", 
    {
        method: "POST",
        headers: {
            "00guid": g_guid,
            "00uploadsize": g_cumulativeSize
        }
    })).text());

    let promises = Object.values(g_fileMap).map(sendFile);
    
    const results = await Promise.allSettled(promises);
    const errors = results.filter(result => result.status === "rejected");
    errors.forEach(e => console.error(e.reason));

    const link = document.createElement("a");
    link.classList.add("downloadLink");

    if (errors.length === 0) {
        link.innerText = g_uploadID;
        link.href = `/${g_uploadID}`;
    }
    else {
        link.innerText = ":(";
        link.href = "/";
    }
    
    container.replaceChildren(link);
}

function handleFileChange() {
    addUniqueFileNames(fileInput.files);
}

function handleKeyDown(e) {
    g_keyStates[e.key] = true;

    if (g_keyStates["Enter"] || g_keyStates[" "]) {
        beginUpload();
    }

    if (g_keyStates["a"]) {
        fileInput.click();
    }
}

function openFileDialogue() {
    fileInput.click();
}

window.onload = () => {
    container = document.getElementById("container");
    
    document.body.onkeydown = handleKeyDown;
    document.body.onkeyup = e => {e.preventDefault(); g_keyStates[e.key] = false};
    fileInput.onchange = handleFileChange;
    container.ondragover = e => {
        e.preventDefault();
        container.classList.add("dragStarted");
    };
    container.ondragleave = () => container.classList.remove("dragStarted");
    container.ondrop = e => {
        e.preventDefault();
        container.classList.remove("dragStarted");
        addUniqueFileNames(e.dataTransfer.files);
    };
}

if (g_guid === null) {
    g_guid = generateGuid();
    window.localStorage.setItem("guid", g_guid);
}

document.cookie = g_guid;