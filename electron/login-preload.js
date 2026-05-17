const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("buptLoginShell", {
  getStartUrl: () => ipcRenderer.invoke("login-shell-get-url"),
  save: () => ipcRenderer.invoke("export-login-session"),
  cancel: () => ipcRenderer.invoke("close-login-window"),
});
