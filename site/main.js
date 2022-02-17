const c_fileNameMaxDisplayLength = 16;
const c_longPressTime = 500;
const c_maxStreams = 16;
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

async function uploadChunk(blob, startByte, fileIndex) {
    const file = g_files[fileIndex];
    g_bytesSent += blob.size;

    const response = await fetch("/", {
        method: "PATCH",
        headers: {
            "upload-id": g_uploadID,
            "file-name": file.name,
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
    
    const numFiles = g_files.length;
    const gridSize = lowestSquareAbove(numFiles);
    const width = 100/gridSize;
    
    matrix.style.gridTemplateColumns = `repeat(auto-fill, ${width}%)`;
    
    for (const file of g_files) {
        const span = document.createElement("span");
        span.classList.add("matrix");
        span.style.backgroundColor = `transparent`;
        matrix.appendChild(span);
    }

    container.replaceChildren(matrix);
}

async function beginUpload() {
    if (g_uploadStarted || g_fileMap.length === 0) {
        return;
    }

    fileList.style.display = "none";
    container.style.cursor = "auto";
    createProgressMatrix();
    console.log("matrix created");

    g_uploadStarted = true;
    fileInput.disabled = true;

    for (const file of g_files) {
        g_cumulativeSize += file.size;
    }

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
        console.log(`stream ${i}: begin`);

        let done = false;
        while (!done) {
            console.log(`stream ${i}: upload start`);
            const p = uploadNextChunk();

            console.log(`stream ${i}`, p);

            if (p !== null) {
                await p;
                console.log(`stream ${i}: upload complete`);
                updateProgressBars();
            }
            else {
                done = true;
            }
            
        }
        console.log(`stream ${i} exiting`);
    };

    for (let i = 0; i < c_maxStreams; ++i) {
        g_activeStreams.push(streamFunc(i).catch(e => {
            console.error("Stream error: "+ e);
        }));
    }

    await Promise.allSettled(g_activeStreams);

    console.log("All files complete");

    const link = document.createElement("a");
    link.classList.add("downloadLink");
    link.innerText = g_uploadID;
    link.href = `/${g_uploadID}`;
    
    container.replaceChildren(link);
}

function updateProgressBars() {
    g_files.forEach((file, index) => {
        const {bytesConfirmed, size} = file;
        const progress = size === 0 ? 1.0 : Math.floor(bytesConfirmed / size);
    
        totalProgress = g_bytesSent / g_cumulativeSize;
        document.title = `> ${Math.floor(totalProgress * 100)}%`;
    
        progressMatrix.children[index].style.backgroundColor = 
            `rgba(${g_accentColour[0]}, ${g_accentColour[1]}, ${g_accentColour[2]}, ${progress})`;
    });
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
    
    const style = getComputedStyle(document.querySelector(":root"));
    g_accentColour[0] = style.getPropertyValue("--accentR");
    g_accentColour[1] = style.getPropertyValue("--accentG");
    g_accentColour[2] = style.getPropertyValue("--accentB");

    document.body.onkeydown = handleKeyDown;
    document.body.onkeyup = e => {e.preventDefault(); g_keyStates[e.key] = false};
    fileInput.onchange = handleFileChange;
    el.onclick = e => {
        if (e.target.tagName === "DIV" && !e.target.classList.contains("fileTracker")) {
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
        container.classList.add("dragStarted");
    };
    el.ondragleave = () => container.classList.remove("dragStarted");;
    el.ondrop = e => {
        e.preventDefault();
        container.classList.remove("dragStarted");
        addUniqueFileNames(e.dataTransfer.files);
    };

    container.style.transition = `background-color ${c_longPressTime}ms`;
}

if (g_guid === null) {
    window.localStorage.setItem("guid", generateGuid());
}