const c_fileNameMaxDisplayLength = 16;
const c_longPressTime = 500;
const g_keyStates = {};
const g_files = {};
let g_guid = window.localStorage.getItem("guid");
let g_uploadID = null;
let g_longTouchTimeout = null;
let g_fileUploadIndex = 0;
let g_uploadStarted = false;
let g_bytesSent = 0;
let g_cumulativeSize = 0;
let g_uploadPromises = null;

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
        g_files[file.name.toLowerCase()] = file;
    });
    updateFileNamesList();
}

function updateFileNamesList() {
    const nameElements = [];

    for (const fileName in g_files) {
        const element = document.createElement("div");
        element.classList.add("fileTracker");

        const nameP = document.createElement("p");
        nameP.classList.add("fileName");
        nameP.innerText = cutName(fileName);

        element.appendChild(nameP);
        element.onclick = () => {
            if (!g_uploadStarted) {
                delete g_files[fileName];
                element.remove();
            }
        };

        nameElements.push(element);
    }

    fileList.replaceChildren(...nameElements);
    fileList.children[0].scrollIntoView();
}

async function uploadChunk(blob, startByte, file) {
    const response = await fetch("/", {
        method: "PATCH",
        headers: {
            "upload-id": g_uploadID,
            "file-name": file.name,
            "file-size": file.size,
            "offset": startByte,
            "guid": g_guid
        },
        body: blob
    });
    
    const bytesReceived = parseInt(response.headers.get("received"));
    g_bytesSent += blob.size;
    file.sent = bytesReceived;
    trackProgress();
}

async function beginUpload() {
    if (g_uploadStarted || g_files.length === 0) {
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
    
    for (const file of Object.values(g_files)) {
        g_uploadPromises = [];
        g_cumulativeSize += file.size;
        let start = 0;
        let end = chunkSize;
        
        while(start < file.size) {
            const p = uploadChunk(file.slice(start, end), start, file);
            g_uploadPromises.push(p);
            
            start = end;
            end = start + chunkSize; //doesn't matter if end is larger than file
        }
        
        await Promise.allSettled(g_uploadPromises);
        console.log("File finished uploading: " + file.name);
        ++g_fileUploadIndex;

        const nextEl = fileList.children[g_fileUploadIndex - 8];
        if (nextEl) {
            nextEl.scrollIntoView({smooth: true});
        }
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

function trackProgress() {
    const files = Object.values(g_files);
    if (g_fileUploadIndex >= files.length) {
        return;
    }

    const el = fileList.children[g_fileUploadIndex];
    const {sent, size} = files[g_fileUploadIndex];
    const progress = Math.floor(sent / size * 100);

    totalProgress = g_bytesSent / g_cumulativeSize;
    document.title = `> ${Math.floor(totalProgress * 100)}%`;
    
    const text = el.querySelector(".fileName");
    el.style.background = `linear-gradient(to right, green ${progress}%, black ${progress}%)`;
    text.style.background = `linear-gradient(to right, black ${progress}%, green ${progress}%)`;
    text.style.backgroundClip = "text";
    text.style.webkitBackgroundClip = "text";
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
    el.ontouchstart = () => g_longTouchTimeout = setTimeout(beginUpload, c_longPressTime);
    el.ontouchend = () => clearTimeout(g_longTouchTimeout);
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
}

if (g_guid === null) {
    window.localStorage.setItem("guid", generateGuid());
}