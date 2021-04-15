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


async function upload(blob, startByte) {
    const response = await fetch("/data", {
        method: "POST",
        headers: {
            "X-File-ID": currentFileID,
            "X-Start": startByte
        },
        body: blob
    });
    
    const bytesReceived = parseInt(response.headers.get("X-Received"));

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


async function sendFile() {
    if (file !== null && currentFileID === null) {
        h.innerText = "..."; //gives instant feedback to the send button

        const response = await fetch("/new", {
            method: "POST",
            headers: {
                "X-DCount": num.value,
                "X-Filename": file.name,
                "X-FileSize": file.size
            }
        });

        currentFileID = response.headers.get("X-File-ID");

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