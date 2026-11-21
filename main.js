const { app, BrowserWindow, dialog, globalShortcut, shell, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");

const logFile = path.join(app.getPath("userData"), "app.log");

// How long to wait for the update check before opening the app anyway
const UPDATE_CHECK_TIMEOUT_MS = 15000;

let mainWindow = null;
let updateWindow = null;
let appStarted = false;
let installing = false;
let updateFound = false;
let checkTimer = null;

function log(...args) {
    const line = "[" + new Date().toISOString() + "] " + args.join(" ") + "\n";

    try {
        fs.appendFileSync(logFile, line);
    } catch (err) {
        console.error("Could not write log:", err);
    }

    console.log(...args);
}

// Catch anything unhandled in the main process
process.on("uncaughtException", (err) => {
    log("UNCAUGHT EXCEPTION:", err.stack || err.message);

    if (app.isReady()) {
        dialog.showErrorBox("Startup error", err.message);
    }
});

process.on("unhandledRejection", (reason) => {
    log(
        "UNHANDLED REJECTION:",
        reason && reason.stack ? reason.stack : String(reason)
    );
});

// Version of the installed app (read by the React Settings page)
ipcMain.handle("app:getVersion", () => app.getVersion());

/* ------------------------------------------------------------------ */
/* Main window                                                         */
/* ------------------------------------------------------------------ */

function createWindow() {
    try {
        mainWindow = new BrowserWindow({
            width: 1400,
            height: 900,

            webPreferences: {
                devTools: true,
                contextIsolation: true,
                nodeIntegration: false,
                preload: path.join(__dirname, "preload.js"),
            },
        });

        mainWindow.on("closed", () => {
            mainWindow = null;
        });

        mainWindow.webContents.on("did-fail-load", (event, code, desc) => {
            log("PAGE LOAD FAILED:", code, desc);
        });

        const indexPath = path.join(__dirname, "frontend", "index.html");

        log(
            "Loading frontend from:",
            indexPath,
            "exists:",
            fs.existsSync(indexPath)
        );

        mainWindow.loadFile(indexPath);
    } catch (err) {
        log("WINDOW CREATION FAILED:", err.stack || err.message);
    }
}

// Opens the real app (only once)
function startApp() {
    if (appStarted) return;
    appStarted = true;

    clearTimeout(checkTimer);

    // Create the main window first so "window-all-closed" never fires in between
    createWindow();
    closeUpdateWindow();
}

/* ------------------------------------------------------------------ */
/* Required-update window                                              */
/* ------------------------------------------------------------------ */

function buildUpdateHtml(version) {
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    * { box-sizing: border-box; }
    body {
        margin: 0;
        height: 100vh;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        font-family: "Segoe UI", Arial, sans-serif;
        background: #1e1f26;
        color: #fff;
        user-select: none;
    }
    h2 { margin: 0 0 8px; font-weight: 600; }
    p { margin: 0 0 20px; color: #b8bcc8; font-size: 14px; }
    .bar {
        width: 320px;
        height: 10px;
        background: #35363f;
        border-radius: 5px;
        overflow: hidden;
    }
    .fill {
        width: 0%;
        height: 100%;
        background: #4f8cff;
        transition: width 0.2s;
    }
    #status { margin-top: 14px; font-size: 13px; color: #b8bcc8; }
</style>
</head>
<body>
    <h2>Update required</h2>
    <p>Version ${version} must be installed to continue.</p>
    <div class="bar"><div class="fill" id="fill"></div></div>
    <div id="status">Starting download...</div>
    <script>
        window.setProgress = function (percent) {
            document.getElementById("fill").style.width = percent + "%";
            document.getElementById("status").textContent =
                "Downloading... " + percent.toFixed(0) + "%";
        };
        window.setStatus = function (text) {
            document.getElementById("status").textContent = text;
        };
    </script>
</body>
</html>`;

    return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

function showUpdateWindow(version) {
    if (updateWindow) return;

    updateWindow = new BrowserWindow({
        width: 460,
        height: 260,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        title: "Update required",
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    updateWindow.setMenu(null);

    // Closing the update window without updating quits the app
    updateWindow.on("closed", () => {
        updateWindow = null;

        if (!appStarted && !installing) {
            log("Update window closed, quitting app");
            app.quit();
        }
    });

    updateWindow.loadURL(buildUpdateHtml(version));
}

function closeUpdateWindow() {
    if (updateWindow) {
        updateWindow.removeAllListeners("closed");
        updateWindow.close();
        updateWindow = null;
    }
}

function updateUi(js) {
    if (updateWindow && !updateWindow.isDestroyed()) {
        updateWindow.webContents.executeJavaScript(js).catch(() => {});
    }
}

/* ------------------------------------------------------------------ */
/* Auto updater                                                        */
/* ------------------------------------------------------------------ */

function startDownload() {
    updateUi('window.setStatus("Starting download...")');

    autoUpdater.downloadUpdate().catch((err) => {
        // The "error" event handler below shows the retry dialog
        log("Download failed:", err.message);
    });
}

function setupAutoUpdater() {
    autoUpdater.logger = {
        info: (...args) => log("UPDATER INFO:", ...args),
        warn: (...args) => log("UPDATER WARN:", ...args),
        error: (...args) => log("UPDATER ERROR:", ...args),
        debug: (...args) => log("UPDATER DEBUG:", ...args),
    };

    // We trigger the download ourselves once the required window is visible
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on("checking-for-update", () => {
        log("Checking for update...");
    });

    autoUpdater.on("update-available", (info) => {
        log("Update available:", info.version);

        updateFound = true;
        clearTimeout(checkTimer);

        showUpdateWindow(info.version);
        startDownload();
    });

    autoUpdater.on("update-not-available", (info) => {
        log("No update available. Current version:", info.version);
        startApp();
    });

    autoUpdater.on("download-progress", (progress) => {
        log("Download progress: " + progress.percent.toFixed(1) + "%");

        updateUi("window.setProgress(" + progress.percent + ")");

        if (updateWindow && !updateWindow.isDestroyed()) {
            updateWindow.setProgressBar(progress.percent / 100);
        }
    });

    autoUpdater.on("update-downloaded", (info) => {
        log("Update downloaded:", info.version);

        installing = true;

        updateUi('window.setStatus("Installing update, the app will restart...")');

        // Short delay so the user sees the message
        setTimeout(() => {
            autoUpdater.quitAndInstall(false, true);
        }, 1000);
    });

    autoUpdater.on("error", async (err) => {
        log("UPDATE ERROR:", err.stack || err.message);

        // Error while checking: don't lock the user out, open the app
        if (!updateFound) {
            startApp();
            return;
        }

        // Error while downloading a required update: retry or quit
        const { response } = await dialog.showMessageBox(updateWindow, {
            type: "error",
            title: "Update failed",
            message: "The update could not be downloaded.",
            detail:
                err.message +
                "\n\nThe update is required to use the application.",
            buttons: ["Retry", "Quit"],
            defaultId: 0,
            cancelId: 1,
        });

        if (response === 0) {
            startDownload();
        } else {
            installing = false;
            app.quit();
        }
    });

    // If the check hangs (no network, server down), open the app anyway
    checkTimer = setTimeout(() => {
        if (!updateFound) {
            log("Update check timed out, starting app");
            startApp();
        }
    }, UPDATE_CHECK_TIMEOUT_MS);

    autoUpdater.checkForUpdates().catch((err) => {
        log("Update check failed:", err.message);
    });
}

/* ------------------------------------------------------------------ */
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
    // Ctrl+Shift+L opens the log file
    globalShortcut.register("CommandOrControl+Shift+L", () => {
        shell.openPath(logFile);
    });

    if (app.isPackaged) {
        // Packaged app: check for a required update before opening
        setupAutoUpdater();
    } else {
        // Dev mode: no updates, open directly
        startApp();
    }
});

app.on("will-quit", () => {
    globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
    app.quit();
});