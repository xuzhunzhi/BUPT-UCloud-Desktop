const credUser = document.getElementById("cred-user");
const credPass = document.getElementById("cred-pass");
const btnAutoLogin = document.getElementById("btn-auto-login");
const linkManual = document.getElementById("link-manual-login");
const statusEl = document.getElementById("login-status");

function setStatus(text, type) {
  statusEl.textContent = text;
  statusEl.classList.remove("err", "ok");
  if (type) statusEl.classList.add(type);
}

async function loadSavedCreds() {
  try {
    const creds = await window.buptHw.getCredentialsConfig();
    if (creds && creds.username) {
      credUser.value = creds.username;
      credPass.value = creds.password || "";
      setStatus("已加载保存的凭据，点击「自动登录」继续", "ok");
    }
  } catch (_) {
    // 无凭据，正常
  }
}

btnAutoLogin.addEventListener("click", async () => {
  const u = credUser.value.trim();
  const p = credPass.value.trim();
  if (!u || !p) {
    setStatus("请输入学号和密码", "err");
    return;
  }

  btnAutoLogin.disabled = true;
  setStatus("正在保存凭据...");

  // 保存凭据到 config.yaml
  try {
    const r = await window.buptHw.saveCredentials(u, p);
    if (r && !r.ok) {
      setStatus("凭据保存失败：" + (r.error || "未知错误"), "err");
      btnAutoLogin.disabled = false;
      return;
    }
  } catch (e) {
    setStatus("凭据保存异常：" + (e.message || e), "err");
    btnAutoLogin.disabled = false;
    return;
  }

  setStatus("正在自动登录（CAS 认证 + 抓取待办）...");

  try {
    const res = await window.buptHw.runFetch();
    const cache = await window.buptHw.getCache();
    const n = (cache.items || []).length;
    if (res.ok && n > 0) {
      setStatus(`登录成功！已抓取 ${n} 条待办。`, "ok");
      try {
        await window.buptHw.openHomeWindow();
      } catch (_) {}
      setTimeout(async () => {
        try { await window.buptHw.closeLoginWindow(); } catch (_) {}
      }, 600);
    } else if (res.ok && n === 0) {
      setStatus("登录似乎成功但未抓取到待办。" + (cache._warning || ""), "err");
      btnAutoLogin.disabled = false;
    } else {
      const tail = (res.logs && (res.logs.stderr || res.logs.stdout)) || res.error || "";
      setStatus("自动登录失败。" + tail.slice(0, 200), "err");
      btnAutoLogin.disabled = false;
    }
  } catch (e) {
    setStatus("自动登录异常：" + (e.message || e), "err");
    btnAutoLogin.disabled = false;
  }
});

linkManual.addEventListener("click", async (e) => {
  e.preventDefault();
  try {
    await window.buptHw.openManualLoginWindow();
    setStatus("请在打开的窗口中完成网页登录，完成后保存即可。");
  } catch (err) {
    setStatus("无法打开手动登录窗口：" + (err.message || err), "err");
  }
});

// 如果已有登录会话，直接跳转主页
(async () => {
  try {
    const ok = await window.buptHw.hasLoginSession();
    if (ok) {
      setStatus("已有登录会话，即将跳转...", "ok");
      setTimeout(async () => {
        try { await window.buptHw.openHomeWindow(); } catch (_) {}
      }, 800);
      return;
    }
  } catch (_) {}
  await loadSavedCreds();
})();

// 监听登录保存事件
if (window.buptHw.onLoginSessionSaved) {
  window.buptHw.onLoginSessionSaved(async () => {
    setStatus("登录已保存！即将跳转...", "ok");
    setTimeout(async () => {
      try { await window.buptHw.openHomeWindow(); } catch (_) {}
    }, 1000);
  });
}
