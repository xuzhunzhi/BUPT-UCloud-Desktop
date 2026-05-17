var loginStatusEl = document.getElementById("login-status");
var btnSaveCred = document.getElementById("btn-save-cred");
var credUser = document.getElementById("cred-user");
var credPass = document.getElementById("cred-pass");
var linkWebviewLogin = document.getElementById("link-webview-login");
var btnDone = document.getElementById("btn-done");
var btnNext = document.getElementById("btn-next");
var btnPrev = document.getElementById("btn-prev");
var statusEl = document.getElementById("status");
var pollTimer = null;

var currentStep = 0;
var TOTAL_STEPS = 4;
var stepPanels = [0, 1, 2, 3].map(function (i) { return document.getElementById("step-" + i); });
var stepDots = document.querySelectorAll(".step-dot");

// Collected prefs across steps
var collectedPrefs = {
  syncMinutes: 30,
  openAtLogin: true,
  startupOpenMode: "home",
  theme: "system",
  alertEnabled: true,
  alertThreeDay: true,
  alertOneDay: true,
  alertUrgent: true,
  alertCooldown3dMin: 360,
  alertCooldown1dMin: 120,
  alertCooldownUrgentMin: 30,
  alertPollMinutes: 15,
};

function setStatus(text, isErr) {
  statusEl.textContent = text;
  statusEl.classList.toggle("err", Boolean(isErr));
}

function updateLoginStatus(text, ok) {
  loginStatusEl.textContent = text;
  loginStatusEl.classList.toggle("ok", Boolean(ok));
}

function selectedTheme() {
  var r = document.querySelector('input[name="theme"]:checked');
  return r ? r.value : "system";
}

function selectedStartupMode() {
  var r = document.querySelector('input[name="startupOpenMode"]:checked');
  return r ? r.value : "home";
}

function updateDots() {
  stepDots.forEach(function (dot, i) {
    dot.classList.remove("active", "done");
    if (i < currentStep) dot.classList.add("done");
    else if (i === currentStep) dot.classList.add("active");
  });
}

function collectAndGoTo(step) {
  // Save current step values before moving
  if (currentStep === 0 && step > 0) {
    // Step 0 -> login already saved by btn-save-cred handler
  }
  if (currentStep === 1) {
    var sm = document.getElementById("sync-minutes");
    collectedPrefs.syncMinutes = Math.max(1, Math.min(1440, parseInt(sm ? sm.value : "30", 10) || 30));
  }
  if (currentStep === 2) {
    collectedPrefs.openAtLogin = document.getElementById("chk-boot").checked;
    collectedPrefs.startupOpenMode = selectedStartupMode();
    collectedPrefs.theme = selectedTheme();
  }
  if (currentStep === 3) {
    collectedPrefs.alertEnabled = document.getElementById("alert-master").checked;
    collectedPrefs.alertThreeDay = document.getElementById("alert-3d").checked;
    collectedPrefs.alertOneDay = document.getElementById("alert-1d").checked;
    collectedPrefs.alertUrgent = document.getElementById("alert-u").checked;
    collectedPrefs.alertCooldown3dMin = Math.max(30, parseInt(document.getElementById("cool-3d").value, 10) || 360);
    collectedPrefs.alertCooldown1dMin = Math.max(15, parseInt(document.getElementById("cool-1d").value, 10) || 120);
    collectedPrefs.alertCooldownUrgentMin = Math.max(5, parseInt(document.getElementById("cool-u").value, 10) || 30);
    collectedPrefs.alertPollMinutes = Math.max(5, Math.min(120, parseInt(document.getElementById("poll-min").value, 10) || 15));
  }
  goToStep(step);
}

function goToStep(n) {
  if (n < 0 || n >= TOTAL_STEPS) return;
  currentStep = n;

  stepPanels.forEach(function (p, i) {
    if (i === n) p.removeAttribute("hidden");
    else p.setAttribute("hidden", "");
  });

  updateDots();

  // Update nav buttons
  btnPrev.hidden = n === 0;
  btnNext.hidden = n === TOTAL_STEPS - 1;
  btnDone.hidden = n !== TOTAL_STEPS - 1;
}

// Step 0: Login
function enableStep1() {
  // Step 0 completed, enable Next button
  // (already always enabled, just update status)
}

async function refreshLoginUi() {
  try {
    var hasSession = await window.buptHw.hasLoginSession();
    var creds = await window.buptHw.getCredentialsConfig();
    if (creds && creds.username && creds.auto_login) {
      credUser.value = creds.username;
      updateLoginStatus("已保存凭据，可继续下一步", true);
    } else if (hasSession) {
      updateLoginStatus("已保存登录状态（Cookie），可继续下一步", true);
    } else {
      updateLoginStatus("尚未保存凭据", false);
    }
  } catch (_) {
    updateLoginStatus("无法检测登录状态", false);
  }
}

async function loadDefaults() {
  try {
    var p = await window.buptHw.getStartupPrefs();
    var theme = p.theme || "system";
    var tr = document.querySelector('input[name="theme"][value="' + theme + '"]');
    if (tr) tr.checked = true;

    var mode = p.startupOpenMode || "home";
    var mr = document.querySelector('input[name="startupOpenMode"][value="' + mode + '"]');
    if (mr) mr.checked = true;

    document.getElementById("chk-boot").checked = p.openAtLogin !== false;
    document.getElementById("alert-master").checked = p.alertEnabled !== false;

    document.getElementById("alert-3d").checked = p.alertThreeDay !== false;
    document.getElementById("alert-1d").checked = p.alertOneDay !== false;
    document.getElementById("alert-u").checked = p.alertUrgent !== false;
    document.getElementById("cool-3d").value = String(p.alertCooldown3dMin ?? 360);
    document.getElementById("cool-1d").value = String(p.alertCooldown1dMin ?? 120);
    document.getElementById("cool-u").value = String(p.alertCooldownUrgentMin ?? 30);
    document.getElementById("poll-min").value = String(p.alertPollMinutes ?? 15);

    try {
      var syncMin = await window.buptHw.getSyncIntervalMinutes();
      document.getElementById("sync-minutes").value = String(syncMin);
    } catch (_) {}
  } catch (_) {}
}

btnSaveCred.addEventListener("click", async function () {
  var u = credUser.value.trim();
  var p = credPass.value.trim();
  if (!u || !p) {
    setStatus("请输入学号和密码", true);
    return;
  }
  btnSaveCred.disabled = true;
  setStatus("正在保存凭据…");
  try {
    var r = await window.buptHw.saveCredentials(u, p);
    if (r && r.ok) {
      setStatus("凭据已保存 ✓");
      updateLoginStatus("已保存凭据，可继续下一步", true);
    } else {
      setStatus(r && r.error ? r.error : "保存失败", true);
    }
  } catch (e) {
    setStatus("保存失败：" + (e.message || e), true);
  }
  btnSaveCred.disabled = false;
});

linkWebviewLogin.addEventListener("click", async function (e) {
  e.preventDefault();
  try {
    await window.buptHw.openLoginWindow();
    setStatus("请在登录窗口完成网页登录，再点击「保存登录并关闭」。");
  } catch (err) {
    setStatus("无法打开登录窗口：" + (err.message || err), true);
  }
});

// Theme change handler
document.querySelectorAll('input[name="theme"]').forEach(function (el) {
  el.addEventListener("change", async function () {
    try {
      await window.buptHw.setTheme(selectedTheme());
    } catch (_) {}
  });
});

window.buptHw.onLoginSessionSaved(function () {
  refreshLoginUi();
  setStatus("网页登录已保存 ✓");
});

// Navigation
btnNext.addEventListener("click", function () {
  collectAndGoTo(currentStep + 1);
});

btnPrev.addEventListener("click", function () {
  collectAndGoTo(currentStep - 1);
});

btnDone.addEventListener("click", async function () {
  // Collect step 3 values
  collectAndGoTo(3); // saves step 3 prefs before done
  goToStep(3); // stay on step 3 visually

  btnDone.disabled = true;
  setStatus("正在保存…");
  try {
    await window.buptHw.completeOnboarding({
      startupOpenMode: collectedPrefs.startupOpenMode,
      openAtLogin: collectedPrefs.openAtLogin,
      autoSyncOnLaunch: true,
      alertEnabled: collectedPrefs.alertEnabled,
      alertThreeDay: collectedPrefs.alertThreeDay,
      alertOneDay: collectedPrefs.alertOneDay,
      alertUrgent: collectedPrefs.alertUrgent,
      alertCooldown3dMin: collectedPrefs.alertCooldown3dMin,
      alertCooldown1dMin: collectedPrefs.alertCooldown1dMin,
      alertCooldownUrgentMin: collectedPrefs.alertCooldownUrgentMin,
      alertPollMinutes: collectedPrefs.alertPollMinutes,
      theme: collectedPrefs.theme,
    });
    // Also save sync interval
    try {
      await window.buptHw.setSyncIntervalMinutes(collectedPrefs.syncMinutes);
    } catch (_) {}
  } catch (e) {
    setStatus("保存失败：" + (e.message || e), true);
    btnDone.disabled = false;
  }
});

function startLoginPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(function () {
    refreshLoginUi();
  }, 1200);
}

// Initialize
loadDefaults().then(function () {
  refreshLoginUi();
  startLoginPoll();
  goToStep(0);
});
