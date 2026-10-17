const { app, BrowserWindow } = require("electron");
const path = require("path");

let win;

function createWindow() {

    win = new BrowserWindow({

        width: 1500,

        height: 900,

        minWidth: 1200,

        minHeight: 700,

        autoHideMenuBar: true,

        webPreferences: {

            nodeIntegration: false,

            contextIsolation: true

        }

    });

    win.loadURL("http://localhost:3000");

}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {

    if (process.platform !== "darwin") {

        app.quit();

    }

});
