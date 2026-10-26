const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');

let mainWindow = null;

const fs = require('fs');

function getIconPath() {
    const candidates = [
        path.join(__dirname, '../res/static/icon.ico'),
        path.join(process.resourcesPath || '', 'res/static/icon.ico'),
        path.join(__dirname, '../webpack/icon.ico'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

function createWindow() {
    const iconPath = getIconPath();
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        title: 'ObjToSchematic',
        ...(iconPath ? { icon: iconPath } : {}),
        backgroundColor: '#1a1a1a',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: false,
            webSecurity: false, // Allows web workers and local assets with file:// protocol
            allowRunningInsecureContent: false,
        },
    });

    // Remove default menu bar for a clean desktop look
    Menu.setApplicationMenu(null);

    // Toggle DevTools with F12 or Ctrl+Shift+I for diagnostics
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
            mainWindow.webContents.toggleDevTools();
        }
    });

    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        console.error('[Electron] Failed to load URL:', validatedURL, errorCode, errorDescription);
    });

    const indexPath = path.join(__dirname, '../webpack/index.html');
    mainWindow.loadFile(indexPath);

    // Open any target="_blank" or window.open links in the user's default browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http:') || url.startsWith('https:')) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
