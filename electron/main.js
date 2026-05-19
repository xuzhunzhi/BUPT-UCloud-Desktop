const { app, BrowserWindow, ipcMain, shell, session, nativeTheme, Notification, Tray, Menu, nativeImage, protocol, net, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, execSync } = require("child_process");

function appLog(msg, err = null) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  let line = `[${ts}] ${msg}`;
  if (err) line += ` | ${err.message || err}`;
  try {
    const logPath = path.join(getDataDir(), "electron.log");
    fs.appendFileSync(logPath, line + "\n");
  } catch (_) {}
  console.log(line);
}
const { parseDueToDate, hoursUntil } = require(path.join(__dirname, "lib", "due-parse.js"));


/** 与 login-shell.html 内 webview partition 一致 */
const LOGIN_PARTITION = "persist:bupt-uclass-login";

const STORAGE_STATE_FILENAME = "playwright_storage_state.json";

const ELECTRON_PREFS_FILENAME = "electron_prefs.json";

const TASK_OVERRIDES_FILENAME = "task_overrides.json";
const COURSE_PREFS_FILENAME = "course_prefs.json";

const DEFAULT_STARTUP_PREFS = {
  /** 是否注册为本机登录项（开机启动应用） */
  openAtLogin: true,
  /** 启动时打开的窗口 */
  startupOpenMode: "home",
  /** 首次引导是否已完成（重装后 prefs 保留则不再显示） */
  onboardingDone: false,
  /** 每次打开应用后是否自动执行一次 Python 抓取 */
  autoSyncOnLaunch: true,
  /** dark | light | system */
  theme: "system",
  /** 待办系统通知 */
  alertEnabled: true,
  alertThreeDay: true,
  alertOneDay: true,
  alertUrgent: true,
  /** 各档位内同一条目最小重复提醒间隔（分钟） */
  alertCooldown3dMin: 360,
  alertCooldown1dMin: 120,
  alertCooldownUrgentMin: 30,
  /** 后台扫描缓存、判断是否发通知的周期（分钟） */
  alertPollMinutes: 15,
  /** 附件下载目录（null 表示 dataDir/attachments） */
  downloadDir: null,
};

const ALERT_NOTIFY_FILENAME = "alert_notify_state.json";

let alertPollTimer = null;

function getElectronPrefsPath() {
  return path.join(getDataDir(), ELECTRON_PREFS_FILENAME);
}

function readElectronPrefs() {
  try {
    const raw = fs.readFileSync(getElectronPrefsPath(), "utf8");
    const j = JSON.parse(raw);
    return {
      ...DEFAULT_STARTUP_PREFS,
      ...j,
    };
  } catch (_) {
    return { ...DEFAULT_STARTUP_PREFS };
  }
}

function writeElectronPrefs(next) {
  const merged = { ...readElectronPrefs(), ...next };
  fs.writeFileSync(getElectronPrefsPath(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

/** 旧版仅有 prefs、无首启字段：视为已使用过本应用，不强制再看向导 */
function migrateLegacyElectronPrefsOnce() {
  const p = getElectronPrefsPath();
  if (!fs.existsSync(p)) return;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const patch = {};
    if (!Object.prototype.hasOwnProperty.call(j, "onboardingDone")) {
      patch.onboardingDone = true;
    }
    if (!Object.prototype.hasOwnProperty.call(j, "startupOpenMode")) {
      patch.startupOpenMode = "home";
    }
    if (Object.keys(patch).length > 0) {
      writeElectronPrefs(patch);
    }
  } catch (e) {
    console.error("migrateLegacyElectronPrefsOnce", e);
  }
}

/** 已有登录会话文件时跳过首启（例如 prefs 丢失但 session 仍在） */
function ensureOnboardingCompleteIfSessionExists() {
  try {
    if (!fs.existsSync(getStorageStatePath())) return;
    const prefs = readElectronPrefs();
    if (prefs.onboardingDone) return;
    writeElectronPrefs({ onboardingDone: true });
  } catch (e) {
    console.error("ensureOnboardingCompleteIfSessionExists", e);
  }
}

function applyStartupWindows(_prefs) {
  createMainWindow();
}

function applyOpenAtLogin(enabled) {
  const on = !!enabled;
  try {
    if (app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: on,
        path: process.execPath,
      });
    } else {
      app.setLoginItemSettings({
        openAtLogin: on,
        path: process.execPath,
        args: [path.resolve(getRepoRoot())],
      });
    }
  } catch (e) {
    console.error("setLoginItemSettings failed:", e);
  }
}

function broadcastCacheUpdated() {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (w && !w.isDestroyed() && w !== loginWindow) {
      w.webContents.send("cache-updated");
    }
  });
}

function scheduleLaunchSync() {
  const prefs = readElectronPrefs();
  if (prefs.autoSyncOnLaunch === false) return;
  const delayMs = 2500;
  setTimeout(() => {
    runFetch();
  }, delayMs);
}

function getConfigYamlPath() {
  return path.join(getDataDir(), "config.yaml");
}

function setWidgetRefreshMinutesInConfig(minutes) {
  const n = Math.max(1, Math.min(24 * 60, parseInt(minutes, 10) || 30));
  const cfgPath = getConfigYamlPath();
  let body = "";
  if (fs.existsSync(cfgPath)) {
    body = fs.readFileSync(cfgPath, "utf8");
  } else {
    const example = path.join(getRepoRoot(), "python", "config.example.yaml");
    if (fs.existsSync(example)) body = fs.readFileSync(example, "utf8");
  }
  if (/^\s*widget_refresh_minutes:/m.test(body)) {
    body = body.replace(/^\s*widget_refresh_minutes:\s*\d+/m, `widget_refresh_minutes: ${n}`);
  } else {
    body += (body.endsWith("\n") ? "" : "\n") + `widget_refresh_minutes: ${n}\n`;
  }
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(cfgPath, body, "utf8");
  return n;
}

function readAlertNotifyState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(getDataDir(), ALERT_NOTIFY_FILENAME), "utf8"));
  } catch (_) {
    return {};
  }
}

function writeAlertNotifyState(obj) {
  fs.writeFileSync(
    path.join(getDataDir(), ALERT_NOTIFY_FILENAME),
    JSON.stringify(obj, null, 2),
    "utf8"
  );
}

function tierForHours(h) {
  if (h > 0 && h <= 24) return "urgent";
  if (h > 24 && h <= 48) return "oneDay";
  if (h > 48 && h <= 72) return "threeDay";
  return null;
}

function tierNotificationTitle(tier) {
  if (tier === "urgent") return "不足 24 小时";
  if (tier === "oneDay") return "约 1～2 天内截止";
  if (tier === "threeDay") return "约 2～3 天内截止";
  return "待办";
}

function runAlertCheck() {
  const prefs = readElectronPrefs();
  if (!prefs.alertEnabled) return;
  if (!Notification.isSupported()) return;

  const cache = readCacheFile();
  const items = cache.items || [];
  const state = readAlertNotifyState();
  const now = Date.now();

  const coolMs = {
    threeDay: Math.max(30, (prefs.alertCooldown3dMin ?? 360) * 60 * 1000),
    oneDay: Math.max(15, (prefs.alertCooldown1dMin ?? 120) * 60 * 1000),
    urgent: Math.max(5, (prefs.alertCooldownUrgentMin ?? 30) * 60 * 1000),
  };

  for (const it of items) {
    const dueStr = it.due || "";
    const dt = parseDueToDate(dueStr);
    if (!dt) continue;
    const h = hoursUntil(dt);
    if (h <= 0) continue;

    const tier = tierForHours(h);
    if (!tier) continue;
    if (tier === "threeDay" && prefs.alertThreeDay === false) continue;
    if (tier === "oneDay" && prefs.alertOneDay === false) continue;
    if (tier === "urgent" && prefs.alertUrgent === false) continue;

    const ck =
      tier === "threeDay" ? "threeDay" : tier === "oneDay" ? "oneDay" : "urgent";
    const cd = coolMs[ck];
    const key = `${ck}|${String(it.title || "").slice(0, 120)}|${dueStr.slice(0, 120)}`;
    const prev = state[key];
    if (prev && now - prev.at < cd) continue;

    const n = new Notification({
      title: `作业待办 · ${tierNotificationTitle(tier)}`,
      body: `${it.title || "（无标题）"}\n${dueStr}`,
    });
    n.show();
    state[key] = { at: now, tier: ck };
  }
  writeAlertNotifyState(state);
}

function restartAlertScheduler() {
  if (alertPollTimer) {
    clearInterval(alertPollTimer);
    alertPollTimer = null;
  }
  const prefs = readElectronPrefs();
  if (!prefs.alertEnabled) return;
  const poll = Math.max(5, Math.min(120, parseInt(prefs.alertPollMinutes, 10) || 15));
  alertPollTimer = setInterval(() => {
    try {
      runAlertCheck();
    } catch (e) {
      console.error("runAlertCheck", e);
    }
  }, poll * 60 * 1000);
  try {
    runAlertCheck();
  } catch (e) {
    console.error("runAlertCheck", e);
  }
}

function broadcastThemeChanged() {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (w && !w.isDestroyed()) {
      w.webContents.send("theme-changed");
    }
  });
}

function broadcastPrefsChanged() {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (w && !w.isDestroyed()) {
      w.webContents.send("prefs-changed");
    }
  });
}

function getRepoRoot() {
  if (app.isPackaged) {
    return path.dirname(process.execPath);
  }
  return path.join(__dirname, "..");
}

function getDataDir() {
  if (app.isPackaged) {
    return app.getPath("userData");
  }
  return getRepoRoot();
}

function getStorageStatePath() {
  return path.join(getDataDir(), STORAGE_STATE_FILENAME);
}

function getPortalUrlFromConfig() {
  const fallback = "https://ucloud.bupt.edu.cn/uclass/index.html#/student/homePage";
  const cfg = path.join(getDataDir(), "config.yaml");
  if (!fs.existsSync(cfg)) return fallback;
  try {
    const t = fs.readFileSync(cfg, "utf8");
    let m = t.match(/^\s*target_url:\s*(.+)$/m);
    if (m) return stripYamlValue(m[1]);
    m = t.match(/^\s*login_start_url:\s*(.+)$/m);
    if (m) return stripYamlValue(m[1]);
  } catch (_) {}
  return fallback;
}

function stripYamlValue(line) {
  let s = line.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }
  // 仅去掉 YAML 行尾注释（空格+#），保留 URL 哈希路由里的 #
  const commentIdx = s.search(/\s#/);
  if (commentIdx >= 0) {
    s = s.slice(0, commentIdx).trim();
  }
  return s || "https://ucloud.bupt.edu.cn/uclass/index.html#/student/homePage";
}

function mapSameSiteForPlaywright(electronSameSite) {
  if (electronSameSite == null) return "Lax";
  const n = typeof electronSameSite === "number" ? electronSameSite : String(electronSameSite).toLowerCase();
  if (n === 1 || n === "strict") return "Strict";
  if (n === 2 || n === "lax") return "Lax";
  if (n === 0 || n === "no_restriction" || n === "none") return "None";
  if (n === "unspecified") return "Lax";
  return "Lax";
}

function electronCookieToPlaywright(c) {
  let expires = -1;
  if (typeof c.expirationDate === "number" && !Number.isNaN(c.expirationDate)) {
    expires = c.expirationDate;
  }
  const domain = (c.domain || "").trim();
  if (!domain) return null;
  return {
    name: c.name,
    value: c.value,
    domain,
    path: c.path && c.path.length ? c.path : "/",
    expires,
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    sameSite: mapSameSiteForPlaywright(c.sameSite),
  };
}

let loginWindow = null;
let mainWindow = null;
let onboardingWindow = null;
let tray = null;

function createTrayIcon() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "app-icon.ico")
    : path.join(getRepoRoot(), "app-icon.ico");
  if (fs.existsSync(iconPath)) return nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAaElEQVR4nO3WQQqAIAwF0Pz3P7J2Ibiw0CYxP7goKI9BMAfoZ5i10Qd2ENMAIkwLIswAIsyAI0Avkx+AoIzgbE4QwAIiGWABkQxwgHAmR2jBDe4dBK0JwgmRgAlJgBhA+/kCwe0PIYCRxwAAAABJRU5ErkJggg=="
  );
}

function getOrCreateTray() {
  if (tray && !tray.isDestroyed()) return tray;
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip("BUPT UCloud Desktop");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示主窗口",
        click: () => { createMainWindow(); },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          tray = null;
          app.exit(0);
        },
      },
    ])
  );
  tray.on("double-click", () => { createMainWindow(); });
  return tray;
}

async function exportLoginSessionFromPartition() {
  const ses = session.fromPartition(LOGIN_PARTITION);
  const all = await ses.cookies.get({});
  const filtered = all.filter(
    (c) =>
      (c.domain && c.domain.includes("bupt.edu.cn")) ||
      (c.domain && String(c.domain).includes("ucloud"))
  );
  const src = filtered.length > 0 ? filtered : all;
  const cookies = [];
  for (const c of src) {
    const pc = electronCookieToPlaywright(c);
    if (pc) cookies.push(pc);
  }
  if (cookies.length === 0) {
    throw new Error("未读取到有效 Cookie，请确认已在页面中完成登录。");
  }

  // 同时导出 localStorage（SPA 可能依赖 localStorage 中的 auth 数据）
  const origins = [];
  if (loginWindow && !loginWindow.isDestroyed()) {
    try {
      const localStorageData = await loginWindow.webContents.executeJavaScript(
        `(function() {
          try {
            var keys = Object.keys(localStorage);
            var items = [];
            for (var i = 0; i < keys.length; i++) {
              try { items.push({ name: keys[i], value: localStorage.getItem(keys[i]) }); }
              catch(e) {}
            }
            return items;
          } catch(e) { return []; }
        })()`
      );
      if (localStorageData && localStorageData.length > 0) {
        origins.push({
          origin: "https://ucloud.bupt.edu.cn",
          localStorage: localStorageData,
        });
      }
    } catch (e) {
      console.error("exportLocalStorage error:", e);
    }
  }

  const state = { cookies, origins };
  fs.writeFileSync(getStorageStatePath(), JSON.stringify(state, null, 2), "utf8");
  return { ok: true, cookieCount: cookies.length, localStorageKeys: origins.length > 0 ? origins[0].localStorage.length : 0 };
}

function getPythonAppPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "python", "bupt-hw", "bupt-hw.exe");
  }
  return path.join(getRepoRoot(), "python", "app.py");
}

function getPythonPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "python", "bupt-hw", "bupt-hw.exe");
  }
  if (process.env.BUPT_PYTHON && fs.existsSync(process.env.BUPT_PYTHON)) {
    return process.env.BUPT_PYTHON;
  }
  const repo = getRepoRoot();
  const venvWin = path.join(repo, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(venvWin)) return venvWin;
  const venvUnix = path.join(repo, ".venv", "bin", "python");
  if (fs.existsSync(venvUnix)) return venvUnix;
  return process.platform === "win32" ? "python" : "python3";
}

function normalizeStartupOpenMode(raw) {
  // Desktop 版本已移除小组件，"widget"/"both" 统一退回 "home"
  if (raw === "widget" || raw === "both") return "home";
  return raw || "home";
}

function getPwBrowsersPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "python", "playwright-browsers");
  }
  return null;
}

function readCacheFile() {
  const p = path.join(getDataDir(), "homework_cache.json");
  if (!fs.existsSync(p)) {
    return {
      updated_at: "",
      items: [],
      _error: "尚未生成 homework_cache.json，请先「立即同步」。若首次使用需在本机安装 Python 依赖（见说明）。",
    };
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return { updated_at: "", items: [], _error: String(e.message) };
  }
}

function getTaskOverridesPath() {
  return path.join(getDataDir(), TASK_OVERRIDES_FILENAME);
}

function readTaskOverrides() {
  const p = getTaskOverridesPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_) { return {}; }
}

function saveTaskOverride(taskId, patch) {
  const overrides = readTaskOverrides();
  const merged = { ...(overrides[taskId] || {}), ...patch };
  Object.keys(merged).forEach(k => { if (merged[k] == null) delete merged[k]; });
  if (Object.keys(merged).length === 0) {
    delete overrides[taskId];
  } else {
    overrides[taskId] = merged;
  }
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(getTaskOverridesPath(), JSON.stringify(overrides, null, 2), "utf8");
}

function getCoursePrefsPath() {
  return path.join(getDataDir(), COURSE_PREFS_FILENAME);
}

function readCoursePrefs() {
  const p = getCoursePrefsPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_) { return {}; }
}

function saveCoursePrefs(prefs) {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(getCoursePrefsPath(), JSON.stringify(prefs, null, 2), "utf8");
}

function applyTaskOverrides(cache) {
  const overrides = readTaskOverrides();
  if (!cache.items || !overrides) return cache;
  cache.items = cache.items.map(function (item) {
    // Use title+course as composite key
    var key = (item.title || "") + "|" + (item.course || "");
    var ov = overrides[key];
    if (ov) {
      return { ...item, ...ov, _overridden: true };
    }
    return item;
  });
  return cache;
}

function getRefreshMinutes() {
  const cfg = path.join(getDataDir(), "config.yaml");
  if (!fs.existsSync(cfg)) return 30;
  try {
    const t = fs.readFileSync(cfg, "utf8");
    const m = t.match(/widget_refresh_minutes:\s*(\d+)/);
    if (m) return Math.max(1, parseInt(m[1], 10));
  } catch (_) {}
  return 30;
}

function runFetch(cmd = "fetch") {
  const py = getPythonPath();
  const script = getPythonAppPath();
  const env = { ...process.env, BUPT_DATA_DIR: getDataDir() };
  const pwPath = getPwBrowsersPath();
  if (pwPath) env.PLAYWRIGHT_BROWSERS_PATH = pwPath;

  return new Promise((resolve) => {
    const logs = { stdout: "", stderr: "" };
    const args = app.isPackaged ? [cmd] : [script, cmd];
    const child = spawn(py, args, {
      cwd: getRepoRoot(),
      env,
      windowsHide: true,
    });
    child.stdout.on("data", (d) => {
      logs.stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      logs.stderr += d.toString();
    });
    child.on("error", (err) => {
      broadcastCacheUpdated();
      resolve({ ok: false, code: -1, logs, error: err.message });
    });
    child.on("close", (code) => {
      const r = { ok: code === 0, code, logs, cache: readCacheFile() };
      broadcastCacheUpdated();
      resolve(r);
    });
  });
}

let manualLoginWindow = null;

function createLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }
  loginWindow = new BrowserWindow({
    width: 480,
    height: 520,
    resizable: false,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  loginWindow.setMenuBarVisibility(false);
  loginWindow.loadFile(path.join(__dirname, "login", "index.html"));
  loginWindow.on("closed", () => {
    loginWindow = null;
  });
}

function createManualLoginWindow() {
  if (manualLoginWindow && !manualLoginWindow.isDestroyed()) {
    manualLoginWindow.focus();
    return;
  }
  manualLoginWindow = new BrowserWindow({
    width: 1024,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "login-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });
  manualLoginWindow.setMenuBarVisibility(false);
  manualLoginWindow.loadFile(path.join(__dirname, "login-shell.html"));
  manualLoginWindow.on("closed", () => {
    manualLoginWindow = null;
  });
}

function attachExternalLinks(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 520,
    minHeight: 420,
    maxWidth: 1100,
    maxHeight: 800,
    frame: false,
    show: true,
    alwaysOnTop: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "app", "index.html"));
  attachExternalLinks(mainWindow);
  mainWindow.on("close", (e) => {
    if (tray && !tray.isDestroyed()) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  return mainWindow;
}

function createSettingsWindow() {
  const win = createMainWindow();
  win.webContents.send("switch-tab", 3);
}

function createOnboardingWindow() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus();
    return;
  }
  onboardingWindow = new BrowserWindow({
    width: 560,
    height: 680,
    minWidth: 480,
    minHeight: 560,
    show: true,
    alwaysOnTop: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  onboardingWindow.setMenuBarVisibility(false);
  onboardingWindow.loadFile(path.join(__dirname, "onboarding", "index.html"));
  attachExternalLinks(onboardingWindow);
  onboardingWindow.on("closed", () => {
    onboardingWindow = null;
  });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // 已有实例运行时再次启动 → 激活已有窗口
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      const visible = wins.filter((w) => w.isVisible());
      if (visible.length > 0) {
        visible[0].focus();
        visible[0].show();
      } else {
        wins[0].show();
        wins[0].focus();
      }
    }
  });

  app.whenReady().then(() => {
  // 注册 attachment:// 协议用于提供本地附件
  protocol.handle("attachment", (request) => {
    const filePath = decodeURIComponent(request.url.replace("attachment:///", ""));
    return net.fetch("file:///" + filePath);
  });

  if (process.platform === "win32") {
    app.setAppUserModelId("edu.bupt.ucloud.desktop");
  }
  app.setName("UCloud Desktop");

  nativeTheme.on("updated", () => {
    broadcastThemeChanged();
  });

  getOrCreateTray();

  migrateLegacyElectronPrefsOnce();
  ensureOnboardingCompleteIfSessionExists();
  const startupPrefs = readElectronPrefs();
  applyOpenAtLogin(startupPrefs.openAtLogin);

  function readCourseCacheFile() {
    const p = path.join(getDataDir(), "course_cache.json");
    if (!fs.existsSync(p)) return { updated_at: "", courses: [], course_count: 0, courseResources: {} };
    try { return JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) { return { updated_at: "", courses: [], course_count: 0, courseResources: {} }; }
  }

  ipcMain.handle("get-cache", () => applyTaskOverrides(readCacheFile()));
  ipcMain.handle("get-course-cache", () => readCourseCacheFile());
  ipcMain.handle("get-task-overrides", () => readTaskOverrides());
  ipcMain.handle("save-task-override", (_e, { taskId, patch }) => {
    saveTaskOverride(taskId, patch);
    return { ok: true };
  });
  ipcMain.handle("get-course-prefs", () => readCoursePrefs());
  ipcMain.handle("save-course-prefs", (_e, prefs) => {
    saveCoursePrefs(prefs);
    return { ok: true };
  });
  ipcMain.handle("get-refresh-minutes", () => getRefreshMinutes());
  ipcMain.handle("run-fetch", () => runFetch("fetch"));
  ipcMain.handle("run-fetch-homework", () => runFetch("sync-homework"));
  ipcMain.handle("run-fetch-courses", () => runFetch("sync-courses"));
  ipcMain.handle("save-credentials", async (_e, { username, password }) => {
    const u = String(username || "").trim();
    const p = String(password || "").trim();
    // 清空凭据
    if (!u && !p) {
      const cfgPath = getConfigYamlPath();
      try {
        let body = "";
        if (fs.existsSync(cfgPath)) {
          body = fs.readFileSync(cfgPath, "utf8").replace(/\r\n/g, "\n");
        }
        if (body) {
          const setKey = (text, key, value) => {
            const re = new RegExp("^(\\s*" + key + ":\\s*).*$", "m");
            if (re.test(text)) return text.replace(re, "$1" + value);
            return text.replace(/\n?$/, "\n" + key + ": " + value + "\n");
          };
          body = setKey(body, "auto_login", "false");
          body = setKey(body, "username", '""');
          body = setKey(body, "password", '""');
          fs.mkdirSync(getDataDir(), { recursive: true });
          fs.writeFileSync(cfgPath, body, "utf8");
        }
        return { ok: true };
      } catch (e) {
        appLog("save-credentials clear error", e);
        return { ok: false, error: String(e.message || e) };
      }
    }
    if (!u || !p) return { ok: false, error: "学号和密码必须同时填写" };

    // 通过 Python 加密密码后写入 config.yaml
    try {
      const { execSync } = require("child_process");
      const py = getPythonPath();
      const encryptCmd = app.isPackaged
        ? `"${py}" encrypt-password`
        : `"${py}" "${path.join(getRepoRoot(), "python", "crypto_cli.py")}" encrypt`;
      appLog("save-credentials encrypting via Python: " + py);
      const result = execSync(
        encryptCmd,
        { cwd: getRepoRoot(), input: p, encoding: "utf8", timeout: 10000 }
      );
      const encrypted = result.trim();
      if (!encrypted) throw new Error("加密失败：输出为空");

      const cfgPath = getConfigYamlPath();
      let body = "";
      if (fs.existsSync(cfgPath)) {
        body = fs.readFileSync(cfgPath, "utf8").replace(/\r\n/g, "\n");
      } else {
        const example = path.join(getRepoRoot(), "python", "config.example.yaml");
        if (fs.existsSync(example)) body = fs.readFileSync(example, "utf8").replace(/\r\n/g, "\n");
      }
      // 只替换顶层 key（不在缩进后的行匹配）
      const setKey = (text, key, value) => {
        const re = new RegExp("^(" + key + ":\\s*).*$", "m");
        if (re.test(text)) return text.replace(re, "$1" + value);
        return text.replace(/\n?$/, "\n" + key + ": " + value + "\n");
      };
      body = setKey(body, "auto_login", "true");
      body = setKey(body, "username", '"' + u + '"');
      body = setKey(body, "password", '"' + encrypted + '"');
      fs.mkdirSync(getDataDir(), { recursive: true });
      fs.writeFileSync(cfgPath, body, "utf8");
      appLog("save-credentials success");
      return { ok: true };
    } catch (e) {
      appLog("save-credentials encrypt error", e);
      return { ok: false, error: String(e.message || e) };
    }
  });
  ipcMain.handle("get-credentials-config", () => {
    const cfgPath = getConfigYamlPath();
    try {
      if (!fs.existsSync(cfgPath)) return { auto_login: false, username: "", password: "" };
      const body = fs.readFileSync(cfgPath, "utf8").replace(/\r\n/g, "\n");
      // 只匹配顶层 key（行首无缩进）
      const m = (key) => {
        const re = new RegExp("^" + key + ":\\s*(.+)$", "m");
        const match = body.match(re);
        if (!match) return "";
        let v = match[1].trim().replace(/\r$/, '');
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        return v;
      };
      let password = m("password");
      // 解密 Fernet token
      if (password.startsWith("gAAAAAB")) {
        try {
          const { execSync } = require("child_process");
          const py = getPythonPath();
          const decryptCmd = app.isPackaged
            ? `"${py}" decrypt-password`
            : `"${py}" "${path.join(getRepoRoot(), "python", "crypto_cli.py")}" decrypt`;
          appLog("get-credentials-config decrypting via Python: " + py);
          const result = execSync(
            decryptCmd,
            { cwd: getRepoRoot(), input: password, encoding: "utf8", timeout: 10000 }
          );
          password = result.trim();
          appLog("get-credentials-config decrypt success");
        } catch (e) {
          appLog("get-credentials-config decrypt error", e);
        }
      }
      return {
        auto_login: m("auto_login") === "true",
        username: m("username"),
        password: password,
      };
    } catch (e) {
      appLog("get-credentials-config error", e);
      return { auto_login: false, username: "", password: "" };
    }
  });
  ipcMain.handle("get-user-info", () => {
    try {
      const authPath = path.join(getDataDir(), "auth_tokens.json");
      if (!fs.existsSync(authPath)) return { ok: false, error: "no token" };
      const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
      const token = auth.iclass_token;
      if (!token) return { ok: false, error: "no token" };
      // Decode JWT payload (base64url)
      const parts = token.split(".");
      if (parts.length < 2) return { ok: false, error: "invalid token" };
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      return {
        ok: true,
        realName: payload.real_name || "",
        avatar: payload.avatar || "",
        studentId: payload.user_name || "",
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("get-startup-prefs", () => {
    let loginItem = {};
    try {
      loginItem = app.getLoginItemSettings();
    } catch (_) {}
    return {
      ...readElectronPrefs(),
      isPackaged: app.isPackaged,
      loginItemOpenAtLogin: loginItem.openAtLogin,
    };
  });
  ipcMain.handle("set-startup-prefs", (_e, patch) => {
    const p = patch || {};
    const next = { ...p };
    if (next.startupOpenMode != null) {
      next.startupOpenMode = normalizeStartupOpenMode(String(next.startupOpenMode));
    }
    const merged = writeElectronPrefs(next);
    if (typeof merged.openAtLogin === "boolean") {
      applyOpenAtLogin(merged.openAtLogin);
    }
    restartAlertScheduler();
    broadcastPrefsChanged();
    return readElectronPrefs();
  });
  ipcMain.handle("get-theme", () => readElectronPrefs().theme || "system");
  ipcMain.handle("set-theme", (_e, theme) => {
    const t = ["dark", "light", "system"].includes(theme) ? theme : "system";
    writeElectronPrefs({ theme: t });
    broadcastThemeChanged();
    return t;
  });
  ipcMain.handle("get-sync-interval-minutes", () => getRefreshMinutes());
  ipcMain.handle("set-sync-interval-minutes", (_e, min) => {
    const n = setWidgetRefreshMinutesInConfig(min);
    broadcastPrefsChanged();
    return n;
  });
  ipcMain.handle("open-settings-window", () => {
    createSettingsWindow();
    return { ok: true };
  });
  ipcMain.handle("get-app-version", () => app.getVersion());

  ipcMain.handle("has-login-session", () => fs.existsSync(getStorageStatePath()));
  ipcMain.handle("open-login-window", () => {
    createLoginWindow();
    return { ok: true };
  });
  ipcMain.handle("open-manual-login-window", () => {
    createManualLoginWindow();
    return { ok: true };
  });
  ipcMain.handle("open-home-window", () => {
    createMainWindow();
    return { ok: true };
  });
  ipcMain.handle("login-shell-get-url", () => ({ url: getPortalUrlFromConfig() }));
  ipcMain.handle("export-login-session", async () => {
    try {
      const r = await exportLoginSessionFromPartition();
      BrowserWindow.getAllWindows().forEach((w) => {
        if (w !== manualLoginWindow && !w.isDestroyed()) {
          w.webContents.send("login-session-saved", r);
        }
      });
      if (manualLoginWindow && !manualLoginWindow.isDestroyed()) {
        manualLoginWindow.close();
      }
      return r;
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });
  ipcMain.handle("open-external", (_e, url) => {
    if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
      shell.openExternal(url);
    }
  });

  ipcMain.handle("show-in-folder", (_e, filePath) => {
    if (filePath && typeof filePath === "string") {
      try {
        shell.showItemInFolder(filePath);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    }
    return { ok: false, error: "invalid path" };
  });

  ipcMain.handle("open-file", (_e, filePath) => {
    if (filePath && typeof filePath === "string") {
      try {
        shell.openPath(filePath);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    }
    return { ok: false, error: "invalid path" };
  });

  /**
   * 在 Electron 主进程发 HTTP 请求（替代 fetch，兼容性更好）。
   * 支持 https: 和 http: 协议。
   */
  function httpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const mod = parsed.protocol === "https:" ? require("https") : require("http");
      const req = mod.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: options.method || "GET",
          headers: options.headers || {},
          rejectUnauthorized: false,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks);
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              headers: res.headers,
              body,
              json: async () => JSON.parse(body.toString("utf-8")),
              text: async () => body.toString("utf-8"),
            });
          });
        },
      );
      req.on("error", reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  // 上传附件
  ipcMain.handle("upload-attachment", async (_e, { filePath, fileName }) => {
    try {
      const authPath = path.join(getDataDir(), "auth_tokens.json");
      appLog("[附件] authPath=" + authPath);
      let auth = {};
      try { auth = JSON.parse(fs.readFileSync(authPath, "utf8")); } catch (_) {}
      const token = auth.iclass_token;
      if (!token) return { ok: false, error: "认证令牌不存在，请先同步: " + authPath };

      const fileBuffer = fs.readFileSync(filePath);
      const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
      const apiBase = auth.api_base || "https://apiucloud.bupt.edu.cn";

      const head = (
        "--" + boundary + "\r\n" +
        'Content-Disposition: form-data; name="file"; filename="' + (fileName || "file") + '"\r\n' +
        "Content-Type: application/octet-stream\r\n\r\n"
      );
      const tail = "\r\n--" + boundary + "--\r\n";
      const body = Buffer.concat([Buffer.from(head, "utf8"), fileBuffer, Buffer.from(tail, "utf8")]);

      appLog("[附件] 上传: " + fileName);
      const result = await httpRequest(`${apiBase}/blade-source/resource/upload/link?bizType=5`, {
        method: "POST",
        headers: {
          "Blade-Auth": token,
          "Content-Type": "multipart/form-data; boundary=" + boundary,
        },
        body: body,
      });

      const rawBody = await result.text();
      let data;
      try { data = JSON.parse(rawBody); } catch (_) { data = rawBody; }
      const fileUrl = (data && data.data) || "";
      appLog("[附件] 上传结果: status=" + result.status + " fileUrl=" + (fileUrl ? fileUrl.slice(0, 50) : "empty"));
      return { ok: result.status >= 200 && result.status < 300 && !!fileUrl, fileUrl, data };
    } catch (e) {
      appLog("[附件] 上传失败: " + (e.message || e));
      return { ok: false, error: e.message || String(e) };
    }
  });

  // 提交作业
  ipcMain.handle("submit-homework", async (_e, { assignmentId, content, assignmentType }) => {
    if (!assignmentId) return { ok: false, error: "missing assignmentId" };
    try {
      const authPath = path.join(getDataDir(), "auth_tokens.json");
      let auth = {};
      try { auth = JSON.parse(fs.readFileSync(authPath, "utf8")); } catch (_) {}
      const token = auth.iclass_token;
      if (!token) return { ok: false, error: "认证令牌不存在，请先同步" };

      const apiBase = auth.api_base || "https://apiucloud.bupt.edu.cn";
      const payload = JSON.stringify({
        assignmentId: String(assignmentId),
        assignmentContent: content || "",
        assignmentType: assignmentType || 0,
        attachmentIds: [],
        userId: "",
        groupId: "",
        commitId: "",
      });

      appLog("[提交] 提交作业: " + assignmentId);
      const result = await httpRequest(`${apiBase}/ykt-site/work/submit`, {
        method: "POST",
        headers: {
          "Blade-Auth": token,
          "Authorization": auth.authorization || "Basic c3dvcmQ6c3dvcmRfc2VjcmV0",
          "Tenant-Id": auth.tenant_id || "000000",
          "Content-Type": "application/json",
        },
        body: payload,
      });

      const rawBody = await result.text();
      let data;
      try { data = JSON.parse(rawBody); } catch (_) { data = rawBody; }
      const ok = result.status >= 200 && result.status < 300 && (!data || data.success !== false);
      return { ok, status: result.status, data };
    } catch (e) {
      appLog("[提交] 提交失败: " + (e.message || e));
      return { ok: false, error: e.message || String(e) };
    }
  });

  async function tryDirectDownload(resourceId, resourceName) {
    const authPath = path.join(getDataDir(), "auth_tokens.json");
    let auth = {};
    try { auth = JSON.parse(fs.readFileSync(authPath, "utf8")); } catch (_) {}
    const token = auth.iclass_token;
    if (!token) return { ok: false, error: "认证令牌不存在，请先同步" };
    const apiBase = auth.api_base || "https://apiucloud.bupt.edu.cn";

    const purlResp = await httpRequest(
      `${apiBase}/blade-source/resource/preview-url?resourceId=${resourceId}`,
      { headers: {
        "Blade-Auth": token,
        "Authorization": auth.authorization || "Basic c3dvcmQ6c3dvcmRfc2VjcmV0",
        "Tenant-Id": auth.tenant_id || "000000",
      }},
    );
    if (!purlResp.ok) {
      const body = await purlResp.text().catch(() => "");
      return { ok: false, error: `preview-url ${purlResp.status}: ${body.slice(0, 100)}` };
    }
    const purlData = await purlResp.json();
    const downloadUrl = (purlData.data && (purlData.data.previewUrl || purlData.data.downloadUrl));
    if (!downloadUrl) return { ok: false, error: "未获取到下载地址" };

    const fileResp = await httpRequest(downloadUrl);
    if (!fileResp.ok) return { ok: false, error: `文件下载失败 (${fileResp.status})` };
    return { ok: true, buffer: Buffer.from(fileResp.body) };
  }

  ipcMain.handle("download-resource", async (_e, resourceId, resourceName, downloadUrl) => {
    if (!resourceId && !downloadUrl) return { ok: false, error: "missing resourceId" };
    if (downloadUrl) {
      try {
        appLog(`[资源] 直接下载: ${downloadUrl.slice(0, 80)}`);
        const fileResp = await httpRequest(downloadUrl);
        if (!fileResp.ok) return { ok: false, error: `下载失败 (${fileResp.status})` };
        const buf = Buffer.from(fileResp.body);
        const prefs = readElectronPrefs();
        const baseDir = prefs.downloadDir || path.join(getDataDir(), "attachments");
        const safeName = resourceName ? resourceName.replace(/[\\/:*?"<>|]/g, "_") : path.basename(downloadUrl.split("?")[0]);
        const filePath = path.join(baseDir, safeName);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, buf);
        appLog(`[资源] 直接下载完成: ${safeName} (${buf.length} bytes)`);
        shell.showItemInFolder(filePath);
        shell.openPath(filePath);
        return { ok: true, filePath };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    }
    const prefs = readElectronPrefs();
    const baseDir = prefs.downloadDir || path.join(getDataDir(), "attachments");
    const safeName = resourceName
      ? resourceName.replace(/[\\/:*?"<>|]/g, "_")
      : `resource_${resourceId}`;
    const filePath = path.join(baseDir, safeName);
    try {
      // 1) Try direct API download
      const direct = await tryDirectDownload(resourceId, resourceName);
      if (direct.ok) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, direct.buffer);
        appLog(`[资源] 下载完成: ${safeName} (${direct.buffer.length} bytes)`);
        shell.showItemInFolder(filePath);
        shell.openPath(filePath);
        return { ok: true, filePath };
      }

      // 2) Fallback to Python Playwright download
      appLog(`[资源] 直接下载失败: ${direct.error}, 回退 Python 下载`);
      const py = getPythonPath();
      const script = getPythonAppPath();
      const pwPath = getPwBrowsersPath();
      const dlEnv = { ...process.env, BUPT_DATA_DIR: getDataDir() };
      if (pwPath) dlEnv.PLAYWRIGHT_BROWSERS_PATH = pwPath;
      const dlResult = await new Promise((resolve) => {
        const args = app.isPackaged
          ? ["download-resource", "--resource-id", resourceId, "--resource-name", resourceName || "file", "--output-dir", baseDir]
          : [script, "download-resource", "--resource-id", resourceId, "--resource-name", resourceName || "file", "--output-dir", baseDir];
        const child = spawn(py, args, { cwd: getRepoRoot(), env: dlEnv });
        let stdout = "", stderr = "";
        child.stdout.on("data", (c) => stdout += c);
        child.stderr.on("data", (c) => stderr += c);
        child.on("close", (code) => {
          const m = stdout.match(/^OK:\s*(.+)$/m);
          resolve({ ok: code === 0 && !!m, filePath: m ? m[1].trim() : filePath, error: stderr || stdout });
        });
      });
      if (dlResult.ok) {
        appLog(`[资源] Python 下载完成: ${dlResult.filePath}`);
        shell.showItemInFolder(dlResult.filePath);
        shell.openPath(dlResult.filePath);
        return { ok: true, filePath: dlResult.filePath };
      }
      return { ok: false, error: dlResult.error || "下载失败" };
    } catch (e) {
      appLog(`[资源] 下载异常: ${resourceName || resourceId}`, e);
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle("get-download-dir", () => {
    const prefs = readElectronPrefs();
    return prefs.downloadDir || null;
  });

  ipcMain.handle("set-download-dir", (_e, dir) => {
    const merged = writeElectronPrefs({ downloadDir: dir || null });
    broadcastPrefsChanged();
    return { ok: true, downloadDir: merged.downloadDir };
  });

  ipcMain.handle("select-download-dir", async () => {
    const prefs = readElectronPrefs();
    const defaultPath = prefs.downloadDir || getDataDir();
    const result = await dialog.showOpenDialog({
      defaultPath,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  });

  ipcMain.handle("select-files", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "所有支持的文件", extensions: ["txt","doc","docx","pdf","xls","xlsx","ppt","pptx","jpg","png","gif","mp3","mp4","zip","rar","7z"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    const path = require("path");
    return { ok: true, files: result.filePaths.map(p => ({ path: p, name: path.basename(p) })) };
  });

  ipcMain.handle("close-login-window", () => {
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.close();
    }
    return { ok: true };
  });

  // Window controls for frameless title bar
  ipcMain.handle("window-minimize", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) win.minimize();
  });
  ipcMain.handle("window-maximize-toggle", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
  });
  ipcMain.handle("window-close", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) win.close();
  });
  ipcMain.handle("window-set-always-on-top", (e, flag) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) win.setAlwaysOnTop(!!flag);
    return !!flag;
  });
  ipcMain.handle("window-get-always-on-top", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? win.isAlwaysOnTop() : true;
  });


  ipcMain.handle("window-is-maximized", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? win.isMaximized() : false;
  });

  ipcMain.handle("complete-onboarding", (_e, patch) => {
    const safe = typeof patch === "object" && patch ? { ...patch } : {};
    if (safe.startupOpenMode != null) {
      safe.startupOpenMode = normalizeStartupOpenMode(String(safe.startupOpenMode));
    }
    const merged = writeElectronPrefs({
      ...safe,
      onboardingDone: true,
    });
    if (typeof merged.openAtLogin === "boolean") {
      applyOpenAtLogin(merged.openAtLogin);
    }
    restartAlertScheduler();
    broadcastThemeChanged();
    broadcastPrefsChanged();
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.close();
    }
    applyStartupWindows(merged);
    return { ok: true };
  });

  const prefsForUi = readElectronPrefs();
  if (!prefsForUi.onboardingDone) {
    createOnboardingWindow();
  } else if (!fs.existsSync(getStorageStatePath())) {
    // 没有登录会话 → 显示登录界面
    createLoginWindow();
  } else {
    applyStartupWindows(prefsForUi);
  }
  scheduleLaunchSync();
  restartAlertScheduler();

  app.on("activate", () => {
    const visibleWindows = BrowserWindow.getAllWindows().filter((w) => w.isVisible());
    if (visibleWindows.length === 0) {
      getOrCreateTray();
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // 不退出：默认收纳到任务栏托盘图标
});

}
