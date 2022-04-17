const c_fileNameMaxDisplayLength = 24;
const c_maxStreams = 4;
const g_keyStates = {};
const g_fileMap = {};

let container = null;

let g_guid = window.localStorage.getItem("guid");
let g_uploadID = null;
let g_uploadStarted = false;
let g_cumulativeSize = 0;
let g_currentFileStartByte = 0;
let g_currentFileIndex = 0;
let g_activeStreams = [];

const g_accentColour = [];

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

    return name.substr(0, c_fileNameMaxDisplayLength - 4 - 1) + ">" + name.substr(-4);
}

function addUniqueFileNames(fileList) {
    Array.from(fileList).forEach(file => {
        g_fileMap[file.name.toLowerCase()] = file;
        file.bytesConfirmed = 0;
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

async function uploadChunk(blob, startByte, fileIndex) {
    const file = Object.values(g_fileMap)[fileIndex];

    const response = await fetch("/", {
        method: "PATCH",
        headers: {
            "upload-id": g_uploadID,
            "file-name": btoa(encodeURIComponent(file.name)),
            "file-size": file.size,
            "offset": startByte,
            "guid": g_guid,
        },
        body: blob
    });

    if (file.success === undefined) {
        file.success = response.ok;
    }
    else {
        file.success ||= response.ok;
    }

    file.bytesConfirmed = Math.max(
        file.bytesConfirmed,
        parseInt(response.headers.get("received"))
    );
}

function getNextChunk(chunkSize) {
    const file = Object.values(g_fileMap)[g_currentFileIndex];

    if (!file) {
        return null;
    }

    const start = g_currentFileStartByte;
    const end = start + chunkSize;
    const slice = file.slice(start, end);
    g_currentFileStartByte = end;
    
    file.sent = end;

    if (end >= file.size) {
        ++g_currentFileIndex;
        g_currentFileStartByte = 0;
    }
    
    return [slice, start];
}

function lowestSquareAbove(x) {
    let answer = 1;

    while (answer ** 2 < x) {
        ++answer;
    }

    return answer;
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

    const info = (await (await fetch("/", 
    {
        method: "POST",
        headers: {
            "guid": g_guid,
            "total-size": g_cumulativeSize
        }
    })).text()).split("/");

    g_uploadID = info[0];
    const chunkSize = parseInt(info[1]);

    const uploadNextChunk = () => {
        const fileIndex = g_currentFileIndex;
        const nextChunk = getNextChunk(chunkSize);
        
        if (nextChunk === null) {
            return null;
        }

        const [chunk, startByte] = nextChunk;
        return uploadChunk(chunk, startByte, fileIndex);
    };

    const streamFunc = async (i) => {
        let done = false;
        while (!done) {
            const p = uploadNextChunk();

            if (p !== null) {
                await p;
                updateProgressBars();
            }
            else {
                done = true;
            }
            
        }
    };

    for (let i = 0; i < c_maxStreams; ++i) {
        g_activeStreams.push(streamFunc(i).catch(e => {
            console.error("Stream error: "+ e);
        }));
    }

    await Promise.allSettled(g_activeStreams);

    const link = document.createElement("a");
    link.classList.add("downloadLink");
    link.innerText = g_uploadID;
    link.href = `/${g_uploadID}`;
    
    container.replaceChildren(link);
}

function updateProgressBars() {
    let totalConfirmed = 0;

    Object.values(g_fileMap).forEach((file, index) => {
        const {bytesConfirmed, size} = file;
        const fileProgress = size === 0 ? 1.0 : (bytesConfirmed / size) * 100;
        totalConfirmed += bytesConfirmed;
        progressMatrix.children[index].style.background = 
        `linear-gradient(to top, var(--accent) ${fileProgress}%, black ${fileProgress}%)`;
    });

    const totalProgress = totalConfirmed / g_cumulativeSize;
    document.title = `> ${Math.floor(totalProgress * 100)}%`;
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
    window.localStorage.setItem("guid", generateGuid());
}