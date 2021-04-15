let loadingInterval = null;
let index = 0;
let file = null;
let currentFileID = null;

function loading() {
    const anim = ["--", "\\", "¦", "/"];
    h.innerText = anim[index];
    index = (index + 1) % anim.length;
}


function filePicked() {
    file = fileInput.files[0];
    fileLabel.innerText = file.name;
}


function parseDCount() {
    const v = num.value;
    num.value = 1;

    if (v !== "") {
        const n = parseInt(v);

        if (!isNaN(n) && n > 0) {
            num.value = n;
        }
    }
}


function upload(blob, blockID) {
    const xhr = new XMLHttpRequest();

    xhr.open('POST', '/data', true);
    xhr.setRequestHeader("X-File-ID", currentFileID);
    xhr.setRequestHeader("X-Block-ID", blockID);
    xhr.onreadystatechange = () => {
        if (xhr.readyState === XMLHttpRequest.DONE) {
            const finished = xhr.getResponseHeader("X-Done");
            
            if (finished) {
                h.innerHTML = `<a href="/${currentFileID}">${currentFileID}</a>`;
                clearInterval(interval);
                currentFileID = null;
            }
        }
    }
    
    xhr.send(blob);
}


function sendFile() {
    if (file !== null && currentFileID === null) {
        console.log("Getting ID from server");
        //first xhr gets id for new file upload
        const newFileXHR = new XMLHttpRequest();
        newFileXHR.open("POST", "/new", true);
        newFileXHR.setRequestHeader("X-DCount", num.value);
        newFileXHR.setRequestHeader("X-Filename", file.name);
        newFileXHR.setRequestHeader("X-FileSize", file.size);
        newFileXHR.onreadystatechange = () => {
            if (newFileXHR.readyState === XMLHttpRequest.DONE) {
                currentFileID = newFileXHR.getResponseHeader("X-File-ID");
                console.log(`Received ID for new file: ${currentFileID}`);

                //split file into chunks and send them
                const bytesPerChunk = 1024 * 1024 * 1;

                let start = 0;
                let end = bytesPerChunk;
                let blockID = 0;

                interval = setInterval(loading, 200);

                while(start < file.size) {
                    upload(file.slice(start, end), blockID++);

                    start = end;
                    end = start + bytesPerChunk; //doesn't matter if end is larger than file
                }
            }
        };
        newFileXHR.send();
    }
}


function filePickHandle(e) {
    fileInput.click();
}


function dropHandle(e) {
    e.preventDefault();

    if (e.dataTransfer.items) {
        for (const item of e.dataTransfer.items) {
            if (item.kind === "file") {
                file = item.getAsFile();
                fileLabel.innerText = file.name;
                document.body.classList.remove("blackbg");
            }
        }
    }
}


function dragHandle(event) {
    event.preventDefault();
    document.body.classList.add("blackbg");
}


function dragLeaveHandle() {
    document.body.classList.remove("blackbg");
}