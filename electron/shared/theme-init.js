(function () {
  async function applyTheme() {
    let t = "system";
    try {
      if (window.buptHw && window.buptHw.getTheme) {
        t = (await window.buptHw.getTheme()) || "system";
      }
    } catch (_) {}
    const root = document.documentElement;
    if (t === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", t);
  }

  function bindThemeListener() {
    if (window.buptHw && window.buptHw.onThemeChanged) {
      window.buptHw.onThemeChanged(() => applyTheme());
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      applyTheme();
      bindThemeListener();
    });
  } else {
    applyTheme();
    bindThemeListener();
  }
})();
