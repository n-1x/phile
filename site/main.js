let index = 0;
let file = null;
let currentFileID = null;

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


function upload(blob, startByte) {
    const xhr = new XMLHttpRequest();

    xhr.open('POST', '/data', true);
    xhr.setRequestHeader("X-File-ID", currentFileID);
    xhr.setRequestHeader("X-Start", startByte);
    xhr.onreadystatechange = () => {
        if (xhr.readyState === XMLHttpRequest.DONE) {
            const bytesReceived = parseInt(xhr.getResponseHeader("X-Received"));

            if (isNaN(bytesReceived)) {
                h.innerText = "E";
            }
            else if (bytesReceived === file.size) {
                h.innerHTML = `<a href="/${currentFileID}">${currentFileID}</a>`;
                currentFileID = null;
            }
            else {
                const percent = Math.floor(bytesReceived / file.size * 100.0);
                h.innerText = `${percent}%`;
            }
        }
    }
    
    xhr.send(blob);
}


function sendFile() {
    if (file !== null && currentFileID === null) {
        h.innerText = "0%"; //this is here to give instant feedback to the send button

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

                while(start < file.size) {
                    upload(file.slice(start, end), start);

                    start = end;
                    end = start + bytesPerChunk; //doesn't matter if end is larger than file
                }
            }
        };
        newFileXHR.send();
    }
}


function filePickHandle(e) {
    if (currentFileID === null) {
        fileInput.click();
    }
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