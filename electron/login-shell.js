document.addEventListener("DOMContentLoaded", async () => {
  const wv = document.getElementById("wv");
  try {
    const res = await window.buptLoginShell.getStartUrl();
    const url = res && res.url;
    if (url && wv) {
      wv.src = url;
    }
  } catch (e) {
    console.error(e);
  }

  document.getElementById("btn-save").addEventListener("click", async () => {
    try {
      const r = await window.buptLoginShell.save();
      if (r && r.ok === false && r.error) {
        alert(r.error);
      }
    } catch (err) {
      alert(String(err && err.message ? err.message : err));
    }
  });
  document.getElementById("btn-cancel").addEventListener("click", () => {
    window.buptLoginShell.cancel();
  });
});
