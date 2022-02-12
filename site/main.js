const c_fileNameMaxDisplayLength = 16;
const c_longPressTime = 500;
const g_keyStates = {};
const g_fileMap = {};
let g_files = null;
let g_guid = window.localStorage.getItem("guid");
let g_uploadID = null;
let g_longTouchTimeout = null;
let g_uploadStarted = false;
let g_bytesSent = 0;
let g_cumulativeSize = 0;
let g_touchStartLoc = null;
let g_currentFileStartByte = 0;
let g_currentFileIndex = 0;

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
    g_files = Object.values(g_fileMap);
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
        element.onclick = () => {
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

async function uploadChunk(blob, startByte, fileName, fileSize, fileIndex) {
    const response = await fetch("/", {
        method: "PATCH",
        headers: {
            "upload-id": g_uploadID,
            "file-name": fileName,
            "file-size": fileSize,
            "offset": startByte,
            "guid": g_guid,
        },
        body: blob
    });

    g_files[fileIndex].bytesConfirmed = Math.max(
        g_files[fileIndex].bytesConfirmed,
        parseInt(response.headers.get("received"))
    );
}

function getNextChunk(chunkSize) {
    const file = g_files[g_currentFileIndex];

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

async function beginUpload() {
    if (g_uploadStarted || g_fileMap.length === 0) {
        return;
    }

    g_uploadStarted = true;
    fileInput.disabled = true;

    const info = (await (await fetch("/", 
    {
        method: "POST",
        headers: {
            "guid": g_guid
        }
    })).text()).split("/");

    g_uploadID = info[0];
    const chunkSize = parseInt(info[1]);

    let done = false;
    
    // Gather up chunks into a bunch of promises up to a maximum blocksize
    // (chunksize used here but could be anything to help client). This 
    // allows sending multiple files at once.
    while (!done) {
        let uploadPromises = [];
        let blockSize = 0;
        
        const topFile = g_files[g_currentFileIndex - 4];
        if (topFile) {
            topFile.listElement.scrollIntoView(true);
        }

        while (blockSize < chunkSize && !done) {
            const fileIndex = g_currentFileIndex;
            const file = g_files[fileIndex];
            const nextChunk = getNextChunk(chunkSize);
            
            if (nextChunk === null) {
                done = true;
            }
            else {
                const [chunk, startByte] = nextChunk;
                const p = uploadChunk(chunk, startByte, file.name, file.size, fileIndex);

                uploadPromises.push(p);
                blockSize += chunk.size;
            }
        }

        updateProgressBars();
        await Promise.allSettled(uploadPromises);
    }

    console.log("All files complete");
    fileList.style.display = "none";

    const link = document.createElement("a");
    link.classList.add("downloadLink");
    link.innerText = g_uploadID;
    link.href = `/${g_uploadID}`;
    
    container.remove();
    document.body.appendChild(link);
}

function updateProgressBars() {
    for (const file of g_files) {
        const {bytesConfirmed, size, listElement} = file;
        const progress = Math.floor((bytesConfirmed / size) * 100);
    
        totalProgress = g_bytesSent / g_cumulativeSize;
        document.title = `> ${Math.floor(totalProgress * 100)}%`;
        
        const text = listElement.querySelector(".fileName");
        listElement.style.background = `linear-gradient(to right, green ${progress}%, black ${progress}%)`;
        text.style.background = `linear-gradient(to right, black ${progress}%, green ${progress}%)`;
        text.style.backgroundClip = "text";
        text.style.webkitBackgroundClip = "text";
    }
}

function handleFileChange() {
    addUniqueFileNames(fileInput.files);
}

function handleKeyDown(e) {
    g_keyStates[e.key] = true;

    if (g_keyStates["Enter"] || g_keyStates[" "]) {
        if (Object.keys(g_fileMap).length) {
            beginUpload();
        }
    }

    if (g_keyStates["a"]) {
        fileInput.click();
    }
}

function clearTouch() {
    container.style.backgroundColor = `black`;
    clearTimeout(g_longTouchTimeout);
    g_longTouchTimeout = null;
}

window.onload = () => {
    const el = container;

    document.body.onkeydown = handleKeyDown;
    document.body.onkeyup = e => {e.preventDefault(); g_keyStates[e.key] = false};
    fileInput.onchange = handleFileChange;
    el.onclick = e => {
        if (e.target.tagName === "DIV") {
            fileInput.click();
        }
    };
    el.ontouchstart = e => {
        if (Object.keys(g_fileMap).length > 0) {
            const {screenX, screenY} = e.changedTouches[0];
            g_touchStartLoc = [screenX, screenY];
            g_longTouchTimeout = setTimeout(beginUpload, c_longPressTime);
            container.style.backgroundColor = "#222"; 
        }
    }
    el.ontouchmove = e => {
        if (Object.keys(g_fileMap).length > 0) {
            const {screenX, screenY} = e.changedTouches[0];
            const dTouch = [screenX - g_touchStartLoc[0], screenY - g_touchStartLoc[1]];
            const distSq = dTouch[0]**2 + dTouch[1]**2;
            
            if (g_longTouchTimeout && distSq > 60) {
                clearTouch();
            }
        }
    }
    el.ontouchend = clearTouch;
    el.ondragover = e => {
        e.preventDefault();
        document.body.classList.add("dragStarted");
    };
    el.ondragleave = () => document.body.classList.remove("dragStarted");;
    el.ondrop = e => {
        e.preventDefault();
        document.body.classList.remove("dragStarted");
        addUniqueFileNames(e.dataTransfer.files);
    };

    container.style.transition = `background-color ${c_longPressTime}ms`;
}

if (g_guid === null) {
    window.localStorage.setItem("guid", generateGuid());
}