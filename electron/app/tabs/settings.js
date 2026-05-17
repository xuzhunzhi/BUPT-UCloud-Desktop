// Settings Tab
var settingsLoaded = false;
var settingsLoaded = false;
var loadedCreds = { username: "", password: "" };

function setSettingsStatus(text, isErr) {
  var el = document.getElementById("settings-status");
  if (el) { el.textContent = text; el.classList.toggle("err", Boolean(isErr)); }
}

async function loadSettings() {
  try {
    var p = await window.buptHw.getStartupPrefs();
    document.getElementById("settings-theme").value = p.theme || "system";

    var sh = document.getElementById("settings-sync-homework");
    if (sh) sh.value = String(p.syncHomeworkHours || 6);
    var sc = document.getElementById("settings-sync-course");
    if (sc) sc.value = String(p.syncCourseDays || 7);

    var chkBoot = document.getElementById("settings-chk-boot");
    var chkAuto = document.getElementById("settings-chk-autosync");
    var autoLogin = document.getElementById("settings-auto-login");
    if (chkBoot) chkBoot.checked = !!p.openAtLogin;
    if (chkAuto) chkAuto.checked = p.autoSyncOnLaunch !== false;
    if (autoLogin) autoLogin.checked = p.auto_login !== false;

    var hintBoot = document.getElementById("settings-hint-boot");
    if (hintBoot) hintBoot.textContent = p.isPackaged ? "" : "开发模式下启动路径可能不准确";

    var alertMaster = document.getElementById("settings-alert-master");
    if (alertMaster) alertMaster.checked = p.alertEnabled !== false;
    var a3d = document.getElementById("settings-alert-3d-h");
    if (a3d) a3d.value = String(p.alertThreeDayHours || 72);
    var a1d = document.getElementById("settings-alert-1d-h");
    if (a1d) a1d.value = String(p.alertOneDayHours || 24);
    var au = document.getElementById("settings-alert-urgent-h");
    if (au) au.value = String(p.alertUrgentHours || 2);
    var poll = document.getElementById("settings-poll-min");
    if (poll) poll.value = String(p.alertPollMinutes || 15);

    var dlDir = document.getElementById("settings-download-dir");
    if (dlDir) {
      try { dlDir.value = await window.buptHw.getDownloadDir() || ""; } catch (_) {}
    }

    try {
      var creds = await window.buptHw.getCredentialsConfig();
      var u = document.getElementById("settings-cred-user");
      var pw = document.getElementById("settings-cred-pass");
      if (creds && creds.username) {
        if (u) u.value = creds.username;
        if (pw) pw.value = creds.password || "";
        loadedCreds = { username: creds.username, password: creds.password || "" };
      } else {
        if (u) u.value = "";
        if (pw) pw.value = "";
        loadedCreds = { username: "", password: "" };
      }
    } catch (_) {}
  } catch (e) {
    setSettingsStatus("加载失败：" + (e.message || e), true);
  }
}

async function saveCredentials() {
  var u = document.getElementById("settings-cred-user").value.trim();
  var p = document.getElementById("settings-cred-pass").value.trim();
  if (!u && !p) { await window.buptHw.saveCredentials("", ""); loadedCreds = { username: "", password: "" }; setSettingsStatus("凭据已清空"); return; }
  if (!u || !p) { setSettingsStatus("学号和密码必须同时填写或同时清空", true); return; }
  var r = await window.buptHw.saveCredentials(u, p);
  if (r && !r.ok) { setSettingsStatus("凭据保存失败：" + (r.error || "未知错误"), true); return; }
  loadedCreds = { username: u, password: p };
  setSettingsStatus("凭据已保存");
}

async function saveAllPrefs() {
  try {
    await window.buptHw.setTheme(document.getElementById("settings-theme").value);
    var sh = parseInt(document.getElementById("settings-sync-homework").value, 10) || 6;
    var sc = parseInt(document.getElementById("settings-sync-course").value, 10) || 7;
    var dlDir = document.getElementById("settings-download-dir");
    if (dlDir) await window.buptHw.setDownloadDir(dlDir.value.trim() || null);
    var autoLogin = document.getElementById("settings-auto-login");
    var chkBoot = document.getElementById("settings-chk-boot");
    var chkAuto = document.getElementById("settings-chk-autosync");
    var alertMaster = document.getElementById("settings-alert-master");
    var a3d = parseInt(document.getElementById("settings-alert-3d-h").value, 10) || 0;
    var a1d = parseInt(document.getElementById("settings-alert-1d-h").value, 10) || 0;
    var au = parseInt(document.getElementById("settings-alert-urgent-h").value, 10) || 0;
    var poll = parseInt(document.getElementById("settings-poll-min").value, 10) || 15;
    await window.buptHw.setStartupPrefs({
      syncHomeworkHours: Math.max(1,Math.min(72,sh)), syncCourseDays: Math.max(1,Math.min(30,sc)),
      startupOpenMode: "home", openAtLogin: chkBoot ? chkBoot.checked : false,
      autoSyncOnLaunch: chkAuto ? chkAuto.checked : true, auto_login: autoLogin ? autoLogin.checked : false,
      alertEnabled: alertMaster ? alertMaster.checked : false,
      alertThreeDayHours: a3d, alertOneDayHours: a1d, alertUrgentHours: au,
      alertPollMinutes: Math.max(5,Math.min(120,poll)),
    });
  } catch (_) {}
}

function setupDownloadDirBrowse() {
  var btn = document.getElementById("settings-btn-browse");
  if (!btn) return;
  btn.addEventListener("click", async function () {
    var result = await window.buptHw.selectDownloadDir();
    if (result.ok && result.path) {
      document.getElementById("settings-download-dir").value = result.path;
      saveAllPrefs();
    }
  });
}

function debounce(fn, ms) {
  var timer;
  return function () { var ctx = this, args = arguments; clearTimeout(timer); timer = setTimeout(function () { fn.apply(ctx, args); }, ms); };
}
function flashSaved(card) { card.classList.add("saved"); setTimeout(function () { card.classList.remove("saved"); }, 600); }

document.addEventListener("DOMContentLoaded", function () {
  var credBtn = document.getElementById("settings-btn-save-creds");
  if (credBtn) credBtn.addEventListener("click", saveCredentials);

  var debouncedSave = debounce(function () {
    saveAllPrefs().then(function () {
      document.querySelectorAll(".settings-card").forEach(function (card) { flashSaved(card); });
    });
  }, 400);

  function wire(sel, ev) { document.querySelectorAll(sel).forEach(function (el) { el.addEventListener(ev, debouncedSave); }); }
  wire('#settings-theme', 'change');
  wire('#settings-sync-homework', 'input');
  wire('#settings-sync-course', 'input');
  wire('#settings-chk-boot', 'change');
  wire('#settings-chk-autosync', 'change');
  wire('#settings-auto-login', 'change');
  wire('#settings-alert-master', 'change');
  wire('#settings-alert-3d-h', 'input');
  wire('#settings-alert-1d-h', 'input');
  wire('#settings-alert-urgent-h', 'input');
  wire('#settings-poll-min', 'input');

  setupDownloadDirBrowse();

  var btnMin = document.getElementById("titlebar-minimize");
  var btnClose = document.getElementById("titlebar-close");
  if (btnMin && window.buptHw.windowMinimize) btnMin.addEventListener("click", function () { window.buptHw.windowMinimize(); });
  if (btnClose && window.buptHw.windowClose) btnClose.addEventListener("click", function () { window.buptHw.windowClose(); });

  var titlebar = document.getElementById("titlebar");
  if (titlebar && window.buptHw.windowMaximizeToggle) {
    titlebar.addEventListener("dblclick", function (e) {
      if (e.target.closest(".titlebar-controls")) return;
      window.buptHw.windowMaximizeToggle();
    });
  }
});
