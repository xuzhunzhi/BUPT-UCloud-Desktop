// Shared utility functions for BUPT UCloud Desktop
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Generate a deterministic color from a string (for course accents)
function stringToColor(str) {
  var hues = [200, 160, 280, 340, 40, 100, 20, 300, 180, 80];
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  var idx = Math.abs(hash) % hues.length;
  return "hsl(" + hues[idx] + ", 55%, 55%)";
}

function sanitizeHtml(html) {
  // Strip script and iframe tags
  return String(html)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/ on\w+="[^"]*"/gi, "")
    .replace(/ on\w+='[^']*'/gi, "");
}

// ===== Shared time utility functions =====
function parseDueDate(due) {
  if (!due || typeof due !== "string") return null;
  var s = due.trim();
  if (!s) return null;

  var m = s.match(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/);
  if (!m) return null;

  var y = parseInt(m[1], 10);
  var mo = parseInt(m[2], 10) - 1;
  var d = parseInt(m[3], 10);
  var hh = 23;
  var mm = 59;
  var ss = 0;

  var tm = s.match(/(\d{1,2})\s*:\s*(\d{2})(?::(\d{2}))?/);
  if (tm) {
    hh = parseInt(tm[1], 10);
    mm = parseInt(tm[2], 10);
    if (tm[3] != null) ss = parseInt(tm[3], 10);
  }

  var dt = new Date(y, mo, d, hh, mm, ss);
  return isNaN(dt.getTime()) ? null : dt;
}

function isOverdue(due) {
  var dt = parseDueDate(due);
  if (!dt) return false;
  return (dt.getTime() - Date.now()) / 3600000 < 0;
}

function hoursUntil(due) {
  var dt = parseDueDate(due);
  if (!dt) return null;
  return (dt.getTime() - Date.now()) / 3600000;
}

function urgencyLabel(it) {
  if (it.submitted) return "已提交";
  if (isOverdue(it.due)) return "已逾期";
  var dt = parseDueDate(it.due);
  if (!dt) return "";
  var hours = (dt.getTime() - Date.now()) / 3600000;
  if (hours < 24) return "即将截止";
  if (hours < 72) return "临近截止";
  return "";
}

function formatDueDisplay(due) {
  if (!due) return "";
  var s = due.replace(/截止\s*$/, "").trim();
  return s.length > 30 ? s.slice(0, 30) + "..." : s;
}
