import JSZip from 'jszip';

export function download(content: any, filename: string) {
    const blob = new Blob([content], { type: filename.endsWith('.obj') ? 'model/obj;charset=utf-8' : 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => {
        URL.revokeObjectURL(url);
    }, 1000);
}

export function downloadAsZip(zipFilename: string, files: { content: any, filename: string }[]) {
    const zip = new JSZip();

    files.forEach((file) => {
        zip.file(file.filename, file.content);
    });

    zip.generateAsync({type: 'blob'}).then(function(content) {
        download(content, zipFilename);
    });
}
