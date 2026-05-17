// Home Tab
// ===== Home Tab =====
(function () {
  var statusHome = document.getElementById("status-home");
  var userAvatar = document.getElementById("user-avatar");
  var userName = document.getElementById("user-name");
  var userId = document.getElementById("user-id");
  var statCourseCount = document.getElementById("stat-course-count");
  var statTaskCount = document.getElementById("stat-task-count");
  var cacheHwUpdated = document.getElementById("cache-hw-updated");
  var cacheCrUpdated = document.getElementById("cache-cr-updated");
  var cacheStatus = document.getElementById("cache-status");

  function setHomeStatus(text, isErr) {
    statusHome.textContent = text;
    statusHome.classList.toggle("err", !!isErr);
  }

  async function refreshHomeStats() {
    try {
      var creds = await window.buptHw.getCredentialsConfig();
      var info = await window.buptHw.getUserInfo();
      if (info && info.ok && info.realName) {
        userName.textContent = info.realName;
        userId.textContent = "学号 " + (info.studentId || (creds && creds.username) || "");
        if (info.avatar) {
          userAvatar.innerHTML = '<img src="' + info.avatar + '" style="width:100%;height:100%;border-radius:50%;object-fit:cover" />';
        } else {
          userAvatar.textContent = (info.realName || "?").charAt(0);
        }
      } else if (creds && creds.username) {
        userName.textContent = creds.username;
        userId.textContent = "学号 " + creds.username;
        userAvatar.textContent = creds.username.charAt(0).toUpperCase();
      } else {
        userName.textContent = "未登录";
        userId.textContent = "";
        userAvatar.textContent = "?";
      }
    } catch (_) {}

    try {
      var data = await window.buptHw.getCache();
      var crData = await window.buptHw.getCourseCache();
      var items = data.items || [];
      var unsubmitted = items.filter(function(it) { return !it.submitted; }).length;
      statTaskCount.textContent = String(unsubmitted);
      var cc = (crData && crData.course_count) || 0;
      statCourseCount.textContent = (cc > 0) ? String(cc) : "—";
      cacheHwUpdated.textContent = "待办上次同步：" + (data.updated_at || "—");
      cacheCrUpdated.textContent = "课程上次同步：" + ((crData && crData.updated_at) || "—");
    } catch (_) {
      statTaskCount.textContent = "—";
      statCourseCount.textContent = "—";
    }
  }

  if (window.buptHw.onCacheUpdated) {
    window.buptHw.onCacheUpdated(refreshHomeStats);
  }

  if (window.buptHw.onPrefsChanged) {
    window.buptHw.onPrefsChanged(refreshHomeStats);
  }

  if (window.buptHw.onLoginSessionSaved) {
    window.buptHw.onLoginSessionSaved(function () {
      refreshHomeStats();
      setHomeStatus("登录已保存。可点击「立即同步」拉取待办。");
    });
  }

  refreshHomeStats().then(function () { setHomeStatus(""); });
})();
