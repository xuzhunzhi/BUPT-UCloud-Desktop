/**
 * 从抓取到的中文截止文案中尽量解析出截止时间（本地时区）。
 * 解析失败返回 null。
 */
function parseDueToDate(due) {
  if (!due || typeof due !== "string") return null;
  const raw = due.trim();
  if (!raw) return null;

  // 1) YYYY-MM-DD 或 YYYY年MM月DD日 或 YYYY/MM/DD（可选时分秒）
  let m = raw.match(/(\d{4})\s*[-\/年]\s*(\d{1,2})\s*[-\/月]\s*(\d{1,2})/);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    const d = parseInt(m[3], 10);
    let hh = 23;
    let mm = 59;
    let ss = 0;
    const tm = raw.match(/(\d{1,2})\s*:\s*(\d{2})(?::(\d{2}))?/);
    if (tm) {
      hh = parseInt(tm[1], 10);
      mm = parseInt(tm[2], 10);
      if (tm[3] != null) ss = parseInt(tm[3], 10);
    }
    const dt = new Date(y, mo, d, hh, mm, ss);
    if (!Number.isNaN(dt.getTime())) return dt;
  }

  // 2) 相对日期：今天/明天/后天/今日/明日/后天 带可选时分
  const relToday = /(今天|今日)\s*(\d{1,2})\s*:\s*(\d{2})/;
  m = raw.match(relToday);
  if (m) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(),
      parseInt(m[2], 10), parseInt(m[3], 10), 0);
  }
  if (/(今天|今日)/.test(raw)) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  }

  const relTomorrow = /(明天|明日)\s*(\d{1,2})\s*:\s*(\d{2})/;
  m = raw.match(relTomorrow);
  if (m) {
    const now = new Date();
    now.setDate(now.getDate() + 1);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(),
      parseInt(m[2], 10), parseInt(m[3], 10), 0);
  }
  if (/(明天|明日)/.test(raw)) {
    const now = new Date();
    now.setDate(now.getDate() + 1);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  }

  if (/(后天)/.test(raw)) {
    const now = new Date();
    now.setDate(now.getDate() + 2);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  }

  // 3) X天后 / X天内
  m = raw.match(/(\d+)\s*天\s*(后|以内|内)/);
  if (m) {
    const n = parseInt(m[1], 10);
    const now = new Date();
    now.setDate(now.getDate() + n);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  }

  // 4) X小时后 / X小时内
  m = raw.match(/(\d+)\s*(个)?\s*(小?时|hour)\s*(后|以内|内)/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const now = new Date();
    return new Date(now.getTime() + n * 3600000);
  }

  // 5) 下周X / 本周X
  const weekMap = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 0, "天": 0 };
  m = raw.match(/(下周|本周)\s*(周|星期)?(\S)/);
  if (m) {
    const isNext = m[1] === "下周";
    const wd = weekMap[m[3]];
    if (wd !== undefined) {
      const now = new Date();
      const currentDay = now.getDay();
      let daysUntil = wd - currentDay;
      if (isNext) daysUntil += 7;
      if (daysUntil <= 0) daysUntil += 7;
      now.setDate(now.getDate() + daysUntil);
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    }
  }

  // 6) MM-DD 或 MM月DD日（无年份，假定当年）
  m = raw.match(/(\d{1,2})\s*[-\/月]\s*(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m && !/\d{4}/.test(raw)) {
    const now = new Date();
    const y = now.getFullYear();
    const mo = parseInt(m[1], 10) - 1;
    const d = parseInt(m[2], 10);
    let hh = 23;
    let mm = 59;
    if (m[3] != null) {
      hh = parseInt(m[3], 10);
      mm = parseInt(m[4], 10);
    }
    const dt = new Date(y, mo, d, hh, mm, 0);
    if (!Number.isNaN(dt.getTime())) {
      // 若计算的日期已过，推到明年
      if (dt.getTime() < Date.now() - 86400000) {
        return new Date(y + 1, mo, d, hh, mm, 0);
      }
      return dt;
    }
  }

  // 7) "X分钟前/后" 等
  m = raw.match(/(\d+)\s*分钟\s*(后|以内)/);
  if (m) {
    const n = parseInt(m[1], 10);
    return new Date(Date.now() + n * 60000);
  }

  return null;
}

/** 距离截止还有多少小时（已过截止则为负数） */
function hoursUntil(date) {
  return (date.getTime() - Date.now()) / 3600000;
}

module.exports = { parseDueToDate, hoursUntil };
