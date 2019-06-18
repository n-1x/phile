let loadingInterval = null;
let index = 0;
let file = null;
let busy = false;

function loading()
{
    const anim = ["--", "\\", "¦", "/"];
    h.innerText = anim[index];
    index = (index + 1) % anim.length;
}


function filePicked()
{
    file = fileInput.files[0];
    fileLabel.innerText = file.name;
}


function parseNumber()
{
    const v = num.value;
    num.value = 1;

    if (v !== "")
    {
        const n = parseInt(v);

        if (!isNaN(n) && n > 0)
        {
            num.value = n;
        }
    }
}


function sendFile()
{
    if (file !== null && !busy)
    {
        const xhr = new XMLHttpRequest();

        busy = true;
        xhr.open("POST", "/", true);
        xhr.setRequestHeader("X-DCount", num.value);
        xhr.setRequestHeader("X-Filename", file.name);
        xhr.onreadystatechange = () => {
            if (xhr.readyState === 4)
            {
                const id = xhr.getResponseHeader("X-File-ID");
                h.innerHTML = `<a href="/${id.toString()}">${id.toString()}</a>`;
                clearInterval(interval);
                busy = false;
            }
        }
    
        xhr.send(file);
        interval = setInterval(loading, 200);
    }
}


function filePickHandle(e)
{
    fileInput.click();
}


function dropHandle(e)
{
    e.preventDefault();

    if (e.dataTransfer.items)
    {
        for (const item of e.dataTransfer.items)
        {
            if (item.kind === "file")
            {
                file = item.getAsFile();
                fileLabel.innerText = file.name;
                document.body.classList.remove("blackbg");
            }
        }
    }
}


function dragHandle(event)
{
    event.preventDefault();
    document.body.classList.add("blackbg");
}


function dragLeaveHandle()
{
    document.body.classList.remove("blackbg");
}