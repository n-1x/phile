const c_fileNameMaxDisplayLength = 24;
const c_maxAttempts = 16;
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
let g_successCount = 0;

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

    return name.substr(0, c_fileNameMaxDisplayLength - 7 - 1) + "..." + name.substr(-7);
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

    g_uploadID = (await (await fetch("/", 
    {
        method: "POST",
        headers: {
            "guid": g_guid,
            "total-size": g_cumulativeSize
        }
    })).text());

    const sendFile = async (file, index) => {
        let attempts = 0;

        while (!file.success && attempts < c_maxAttempts) {
            const response = await fetch(`/${g_uploadID}`, {
                method: "PATCH",
                headers: {
                    "upload-id": g_uploadID,
                    "file-name": btoa(encodeURIComponent(file.name)),
                    "guid": g_guid,
                },
                body: file
            });

            file.success = response.ok;
            ++attempts;
        }

        if (!file.success) {
            throw `${file.name} failed after ${attempts} attempts`;
        }
        else {
            ++g_successCount;
            progressMatrix.children[index].style.background = "var(--accent)";
            document.title = `> ${Math.floor(g_successCount / Object.values(g_fileMap).length * 100)}%`;
        }
    };

    let promises = Object.values(g_fileMap).map((file, index) => sendFile(file, index));

    const results = await Promise.allSettled(promises);
    const success = !results.some(result => result.status === "rejected");

    const link = document.createElement("a");
    link.classList.add("downloadLink");

    if (success) {
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
    window.localStorage.setItem("guid", generateGuid());
}

document.cookie = window.localStorage.getItem("guid");