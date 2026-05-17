const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("buptHw", {
  getCache: () => ipcRenderer.invoke("get-cache"),
  getCourseCache: () => ipcRenderer.invoke("get-course-cache"),
  getRefreshMinutes: () => ipcRenderer.invoke("get-refresh-minutes"),
  runFetch: () => ipcRenderer.invoke("run-fetch"),
  runFetchHomework: () => ipcRenderer.invoke("run-fetch-homework"),
  runFetchCourses: () => ipcRenderer.invoke("run-fetch-courses"),
  hasLoginSession: () => ipcRenderer.invoke("has-login-session"),
  openLoginWindow: () => ipcRenderer.invoke("open-login-window"),
  openManualLoginWindow: () => ipcRenderer.invoke("open-manual-login-window"),
  closeLoginWindow: () => ipcRenderer.invoke("close-login-window"),

  openHomeWindow: () => ipcRenderer.invoke("open-home-window"),
  openSettingsWindow: () => ipcRenderer.invoke("open-settings-window"),
  saveCredentials: (u, p) => ipcRenderer.invoke("save-credentials", { username: u, password: p }),
  getCredentialsConfig: () => ipcRenderer.invoke("get-credentials-config"),
  getStartupPrefs: () => ipcRenderer.invoke("get-startup-prefs"),
  setStartupPrefs: (patch) => ipcRenderer.invoke("set-startup-prefs", patch),
  getTheme: () => ipcRenderer.invoke("get-theme"),
  setTheme: (t) => ipcRenderer.invoke("set-theme", t),
  getSyncIntervalMinutes: () => ipcRenderer.invoke("get-sync-interval-minutes"),
  setSyncIntervalMinutes: (min) => ipcRenderer.invoke("set-sync-interval-minutes", min),
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximizeToggle: () => ipcRenderer.invoke("window-maximize-toggle"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowSetAlwaysOnTop: (flag) => ipcRenderer.invoke("window-set-always-on-top", flag),
  windowGetAlwaysOnTop: () => ipcRenderer.invoke("window-get-always-on-top"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  onLoginSessionSaved: (fn) => {
    ipcRenderer.on("login-session-saved", (_e, data) => fn(data));
  },
  onCacheUpdated: (fn) => {
    ipcRenderer.on("cache-updated", () => fn());
  },
  onThemeChanged: (fn) => {
    ipcRenderer.on("theme-changed", () => fn());
  },
  onPrefsChanged: (fn) => {
    ipcRenderer.on("prefs-changed", () => fn());
  },
  completeOnboarding: (patch) => ipcRenderer.invoke("complete-onboarding", patch),
  onSwitchTab: (fn) => {
    ipcRenderer.on("switch-tab", (_e, index) => fn(index));
  },
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  showInFolder: (filePath) => ipcRenderer.invoke("show-in-folder", filePath),
  openFile: (filePath) => ipcRenderer.invoke("open-file", filePath),
  downloadResource: (resourceId, resourceName) => ipcRenderer.invoke("download-resource", resourceId, resourceName),
  submitHomework: (params) => ipcRenderer.invoke("submit-homework", params),
  uploadAttachment: (params) => ipcRenderer.invoke("upload-attachment", params),
  selectFiles: () => ipcRenderer.invoke("select-files"),
  getUserInfo: () => ipcRenderer.invoke("get-user-info"),
  getDownloadDir: () => ipcRenderer.invoke("get-download-dir"),
  setDownloadDir: (dir) => ipcRenderer.invoke("set-download-dir", dir),
  selectDownloadDir: () => ipcRenderer.invoke("select-download-dir"),
  getTaskOverrides: () => ipcRenderer.invoke("get-task-overrides"),
  saveTaskOverride: (taskId, patch) => ipcRenderer.invoke("save-task-override", { taskId, patch }),
  getCoursePrefs: () => ipcRenderer.invoke("get-course-prefs"),
  saveCoursePrefs: (prefs) => ipcRenderer.invoke("save-course-prefs", prefs),
});
