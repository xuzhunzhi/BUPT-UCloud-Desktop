"""DOM 与 API JSON 的课业数据提取策略。"""
from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urljoin

from playwright.sync_api import Page

from models import HomeworkItem


def _normalize_due_for_dedup(due: str) -> str:
    """标准化截止时间用于去重比较：去除'截止'后缀、统一时分秒格式。"""
    d = (due or "").strip()
    d = re.sub(r"截止\s*$", "", d)
    d = re.sub(r"(\d{2}:\d{2}):\d{2}", r"\1", d)
    return d[:120]


def _dedupe_homework_items(items: list[HomeworkItem]) -> list[HomeworkItem]:
    seen: dict[tuple[str, str], int] = {}  # key -> index in out
    out: list[HomeworkItem] = []
    for it in items:
        key = (it.title[:240], _normalize_due_for_dedup(it.due))
        if key in seen:
            idx = seen[key]
            if _is_richer(it, out[idx]):
                out[idx] = it
            continue
        seen[key] = len(out)
        out.append(it)
    return out


def _is_richer(a: HomeworkItem, b: HomeworkItem) -> bool:
    """a 是否比 b 包含更多有意义的数据。"""
    score_a = (bool(a.submitted), bool(a.course), bool(a.content), bool(a.url))
    score_b = (bool(b.submitted), bool(b.course), bool(b.content), bool(b.url))
    return score_a > score_b


def _filter_junk_items(items: list[HomeworkItem]) -> list[HomeworkItem]:
    """过滤明显不是课业条目的垃圾结果（侧边栏统计数字、导航标签等）。"""
    out: list[HomeworkItem] = []
    for it in items:
        title = it.title.strip()
        raw = (it.raw or "").strip()
        due = (it.due or "").strip()

        # 标题为纯数字（如 "14"、"36"）
        if title.isdigit():
            continue
        # 标题过短且无中文，很可能是 badge/icon 文本
        if len(title) < 4 and not re.search(r"[一-鿿]", title):
            continue
        # 空壳条目：raw == title 且无截止日期/课程，大概率是页面标签/分类标题
        if raw.strip() == title and not due and not it.course:
            continue
        # 标题等于 raw 且只有几个字、无课业关键词
        if title == raw and len(title) <= 4:
            if not re.search(r"作业|任务|测验|考试|问卷|实验|报告|提交|截止", title):
                continue
        # raw 看起来像 "数字\n标签" 的统计 badge
        lines = [x.strip() for x in raw.split("\n") if x.strip()]
        if len(lines) == 2 and lines[0].isdigit():
            if re.match(r"^(课程|班级|学生|教师|待办|通知|消息|作业|任务)$", lines[1]):
                continue
        # 标题是纯数字+单位（如 "14门"、"36条"）
        if re.match(r"^\d+\s*(门|条|个|项|人|次|篇)$", title):
            continue
        # 标题看起来像导航菜单项而非课业
        nav_patterns = [
            "首页", "个人中心", "设置", "退出", "消息中心", "通知", "我的课程",
            "课程中心", "教师主页", "学生主页", "学情首页", "课程基本信息",
            "我的课堂", "我的课堂-学生", "我的问卷-学生",
            "教学云平台菜单", "查看成绩",
        ]
        if title in nav_patterns:
            continue
        # 看起来像菜单/权限条目（含 "-老师"/"-学生" 后缀且无截止时间）
        if re.search(r"-(老师|学生|教师)$", title) and not due:
            continue
        # 无截止时间且标题像通用页面名
        if not due and re.match(
            r"^(作业|主题|问卷|反馈|反思|公告|测验|讨论|成员|课件|考勤|签到).{0,10}(列表|详情|首页|中心|信息|数据)",
            title,
        ):
            continue
        # 看起来像新闻/通知而非课业（含"通报"、"公示"且无关作业截止）
        if re.search(r"(通报|公示|通知$)", title) and not re.search(r"作业|提交|截止|实验|考试|测验", title):
            continue

        out.append(it)
    return out


def extract_homework_from_json_tree(data: Any, source_url: str = "") -> list[HomeworkItem]:
    """从接口返回的 JSON 递归提取疑似课业条目（教学空间多为接口渲染 DOM）。"""
    title_key_pref = (
        "homeworkTitle",
        "activityTitle",
        "taskTitle",
        "activityName",
        "paperTitle",
        "lessonTitle",
        "taskName",
        "title",
        "subjectName",
        "courseHomeworkTitle",
        "assignmentTitle",
        "name",
    )
    title_key_re = re.compile(
        r"(title|homework|activity|task|paper|lesson|subject|course|assignment|workName)",
        re.I,
    )
    time_key_re = re.compile(
        r"(deadline|endTime|dueDate|submitEnd|closeTime|expire|limitTime|endDate|assignmentEndTime)",
        re.I,
    )
    out: list[HomeworkItem] = []
    seen: set[tuple[str, str]] = set()
    nodes = 0
    max_nodes = 35_000

    def maybe_emit_from_dict(d: dict[str, Any]) -> None:
        nonlocal out
        if len(json.dumps(d, ensure_ascii=False)) > 50_000:
            return
        blob = json.dumps(d, ensure_ascii=False)
        title = ""
        matched_pref = ""
        for pk in title_key_pref:
            for k, v in d.items():
                if str(k).lower() != pk.lower():
                    continue
                if isinstance(v, str) and len(v.strip()) > 3:
                    title = v.strip()[:500]
                    matched_pref = pk.lower()
                    break
            if title:
                break
        if not title:
            for k, v in d.items():
                if not isinstance(v, str):
                    continue
                if len(v.strip()) < 4:
                    continue
                if title_key_re.search(str(k)):
                    title = v.strip()[:500]
                    break
        if not title:
            return
        strong_pref = matched_pref and matched_pref not in ("title", "name")
        if not strong_pref and not re.search(
            r"作业|任务|测验|考试|问卷|预习|实验|报告|讨论|待办|homework|assignment|todo|course",
            blob,
            re.I,
        ):
            return
        due = ""
        course = ""
        for k, v in d.items():
            if not isinstance(v, str):
                continue
            vs = v.strip()
            if not vs:
                continue
            lk = str(k)
            if time_key_re.search(lk):
                due = vs[:220]
            if re.search(r"courseName|courseTitle|siteName|班级|课程名", lk, re.I):
                course = vs[:200]

        submitted = False
        content = ""
        for k, v in d.items():
            lk = str(k).lower()
            if not submitted:
                if lk in ("submitted", "issubmitted", "submitstatus", "commitstatus"):
                    if isinstance(v, bool):
                        submitted = v
                    elif isinstance(v, str):
                        submitted = v.lower() in ("true", "1", "yes", "submitted", "done", "已提交", "已完成")
                if lk == "submittime" and isinstance(v, str) and len(v.strip()) > 5:
                    submitted = True
            if not content and isinstance(v, str) and len(v.strip()) > 0:
                if re.search(r"content|description|introduction|detail|workcontent|remark|requirement", lk):
                    content = v.strip()[:3000]

        raw = blob[:500]
        key = (title[:240], due[:120])
        if key in seen:
            return
        seen.add(key)
        out.append(
            HomeworkItem(
                title=title,
                course=course,
                due=due,
                raw=raw,
                url=source_url[:300],
                submitted=submitted,
                content=content,
            )
        )

    def walk(obj: Any, depth: int) -> None:
        nonlocal nodes
        if depth > 14 or nodes > max_nodes:
            return
        nodes += 1
        if isinstance(obj, dict):
            maybe_emit_from_dict(obj)
            for v in obj.values():
                walk(v, depth + 1)
        elif isinstance(obj, list):
            for el in obj[:900]:
                walk(el, depth + 1)

    walk(data, 0)
    return out


def _items_from_network_bucket(bucket: list[dict[str, Any]]) -> list[HomeworkItem]:
    items: list[HomeworkItem] = []
    skip_url_substrings = [
        "/menu/role-grant",
        "/menu/",
        "/oauth/token",
        "/userroledomaindept/",
        "/base-term/",
        "/inform/news/",
        "/blade-portal/",
        "/news/",
    ]
    for row in bucket:
        url = row.get("url", "")
        if any(s in url for s in skip_url_substrings):
            continue
        items.extend(extract_homework_from_json_tree(row.get("data"), row.get("url", "")))
    return _dedupe_homework_items(items)


def _text(el) -> str:
    try:
        return (el.inner_text() or "").strip()
    except Exception:
        return ""


def _max_items_cap(cfg: dict[str, Any]) -> int | None:
    """max_todo_items <= 0 表示不限制条数。"""
    try:
        v = int(cfg.get("max_todo_items", 0))
    except (TypeError, ValueError):
        v = 0
    return None if v <= 0 else max(1, v)


def scroll_to_load_lazy_content(
    page: Page,
    *,
    rounds: int = 28,
    pause_ms: int = 400,
) -> None:
    """反复滚到底以触发虚拟列表/懒加载，尽量拉全待办 DOM。"""
    rounds = max(1, min(rounds, 80))
    pause_ms = max(100, min(pause_ms, 3000))
    last_height = -1
    stable = 0
    for _ in range(rounds):
        try:
            height = page.evaluate("() => document.documentElement.scrollHeight") or 0
        except Exception:
            break
        try:
            page.evaluate("() => window.scrollTo(0, document.documentElement.scrollHeight)")
        except Exception:
            break
        page.wait_for_timeout(pause_ms)
        try:
            new_h = page.evaluate("() => document.documentElement.scrollHeight") or 0
        except Exception:
            break
        if new_h == last_height:
            stable += 1
            if stable >= 2:
                break
        else:
            stable = 0
        last_height = new_h
    try:
        page.evaluate("() => window.scrollTo(0, 0)")
    except Exception:
        pass
    page.wait_for_timeout(250)


def _heuristic_text_matches_todo(raw: str) -> bool:
    """尽量覆盖各类待办文案，避免只抓到「作业」等部分条目。"""
    if len(raw) < 4:
        return False
    if re.search(
        r"作业|任务|测验|考试|问卷|讨论|提交|待办|预习|通知|公告|实验|报告|截止|逾期|期限"
        r"|课件|直播|签到|成绩|课程名称|教学班|学习进度|章节",
        raw,
    ):
        return True
    return False


def _raw_looks_like_assignment_row(raw: str) -> bool:
    """表格行等：含作业相关词，或「日期 + 课程/作业类词」。"""
    if len(raw) < 8 or len(raw) > 2500:
        return False
    if _heuristic_text_matches_todo(raw):
        return True
    if re.search(r"\d{4}\s*[-年./]\s*\d{1,2}", raw) and re.search(
        r"课程|作业|提交|截止|待办|测验|名称|状态|类型|操作|查看|学习|章节", raw
    ):
        return True
    return False


def _first_row_link(page: Page, row) -> str:
    """取条目内第一个可跳转链接（绝对或相对 URL）。"""
    try:
        links = row.locator("a[href]")
        if links.count() == 0:
            return ""
        href = (links.first.get_attribute("href") or "").strip()
        if not href or href.startswith("#") or href.lower().startswith("javascript:"):
            return ""
        if href.startswith("http"):
            return href
        base = page.url or ""
        if base:
            return urljoin(base, href)
    except Exception:
        pass
    return ""


def extract_with_selector(
    page: Page,
    item_sel: str,
    title_rel: str,
    due_rel: str,
    max_items: int | None,
) -> list[HomeworkItem]:
    items: list[HomeworkItem] = []
    loc = page.locator(item_sel)
    n = loc.count()
    limit = n if max_items is None else min(n, max_items)
    for i in range(limit):
        row = loc.nth(i)
        raw = _text(row)
        if not raw or len(raw) > 2000:
            continue
        title = _text(row.locator(title_rel)) if title_rel else raw.split("\n")[0][:200]
        due = _text(row.locator(due_rel)) if due_rel else ""
        if not due:
            m = re.search(
                r"(截止|提交|逾期).*?(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?\s*\d{0,2}:?\d{0,2}:?\d{0,2}?|今天|明天|本周|下周|\d{1,2}:\d{2})",
                raw,
            )
            if m:
                due = m.group(0)[:120]
        course = ""
        lines = [x.strip() for x in raw.split("\n") if x.strip()]
        if len(lines) >= 2 and len(lines[1]) < 80:
            course = lines[1]
        link = _first_row_link(page, row)
        items.append(
            HomeworkItem(title=title or "（无标题）", course=course, due=due, raw=raw[:500], url=link)
        )
    return items


def _looks_like_due_line(s: str) -> bool:
    """识别「截止/提交期限」等行：兼容站点只用「提交时间」、相对日期、时分。"""
    if not s or len(s) > 400:
        return False

    if re.search(r"无截止|未截止|没有截止|暂未", s):
        return False

    has_deadline_word = bool(
        re.search(
            r"截止|提交期限|提交截止|最迟|期限|逾期|剩余|提交时间|上交时间|到期时间|截止日期|结束时间|Due\s*date|Due\s*:",
            s,
            re.I,
        )
    )
    if not has_deadline_word:
        if re.search(r"(提交时间|上交时间|到期时间|截止日期)\s*[:：]?\s*", s) and (
            re.search(r"\d{4}\s*[-年./]\s*\d{1,2}", s)
            or re.search(r"(今天|明天|后天|今日)", s)
            or re.search(r"\d{1,2}\s*:\s*\d{2}", s)
        ):
            return True
        return False
    if re.search(r"\d{4}\s*[-年./]\s*\d{1,2}\s*[-月./]\s*\d{1,2}", s):
        return True
    if re.search(r"\d{1,2}\s*:\s*\d{2}", s):
        return True
    if re.search(r"(今天|明天|后天|今日|明日|本周|下周|小时后|分钟内)", s):
        return True
    if re.search(r"\d+\s*天\s*(后|以内|内)", s):
        return True
    if re.search(r"剩余\s*\d+\s*(小时|分钟|天)", s):
        return True
    if re.search(r"\d{1,4}[-月./日\s:：]{2,24}\d{1,2}", s):
        return True
    return True


def parse_todo_panel_blob(text: str) -> list[HomeworkItem]:
    lines = [ln.strip() for ln in text.replace("\r", "").split("\n")]
    lines = [ln for ln in lines if ln]
    header = re.compile(r"^(待办|待办事项|今日待办|我的待办|学习任务)$")
    counter = re.compile(r"^\d+\s*/\s*\d+$")
    out: list[HomeworkItem] = []
    i = 0
    while i < len(lines):
        ln = lines[i]
        if header.match(ln) or counter.match(ln):
            i += 1
            continue
        if i + 1 < len(lines) and _looks_like_due_line(lines[i + 1]):
            title = ln
            due = lines[i + 1]
            if not header.match(title) and not counter.match(title):
                out.append(
                    HomeworkItem(
                        title=title[:500],
                        course="",
                        due=due[:200],
                        raw=f"{title}\n{due}"[:500],
                        url="",
                    )
                )
            i += 2
            continue
        if _looks_like_due_line(ln) and not out:
            out.append(HomeworkItem(title="（无标题）", course="", due=ln[:200], raw=ln[:500], url=""))
        i += 1
    return out


def expand_combined_todo_items(items: list[HomeworkItem]) -> list[HomeworkItem]:
    expanded: list[HomeworkItem] = []
    for it in items:
        raw = it.raw or ""
        n_deadline = raw.count("截止")
        if n_deadline > 1 or (len(raw) > 200 and "截止" in raw and "\n" in raw):
            parsed = parse_todo_panel_blob(raw)
            if len(parsed) >= 2:
                expanded.extend(parsed)
                continue
            parsed = parse_todo_panel_blob(it.title + "\n" + raw)
            if len(parsed) >= 2:
                expanded.extend(parsed)
                continue
        expanded.append(it)
    seen: set[str] = set()
    uniq: list[HomeworkItem] = []
    for it in expanded:
        key = (it.title, it.due)
        if key in seen:
            continue
        seen.add(key)
        uniq.append(it)
    return uniq


def parse_loose_deadline_pairs(text: str) -> list[HomeworkItem]:
    """整页纯文本兜底：按行扫描，把「截止」行前一行当作标题。"""
    lines = [ln.strip() for ln in text.replace("\r", "").split("\n") if ln.strip()]
    out: list[HomeworkItem] = []
    for i, ln in enumerate(lines):
        if not _looks_like_due_line(ln):
            continue
        title = lines[i - 1] if i > 0 else "（无标题）"
        if _looks_like_due_line(title) or len(title) < 2:
            title = "（无标题）"
        out.append(
            HomeworkItem(
                title=title[:500],
                course="",
                due=ln[:200],
                raw=f"{title}\n{ln}"[:500],
                url="",
            )
        )
    return out


def extract_table_like_rows(page: Page, max_items: int | None) -> list[HomeworkItem]:
    """表格行 / 列表项：教学空间常用 Element、Ant Design 等表格结构。"""
    selectors = [
        "table tbody tr",
        ".el-table__body-wrapper tbody tr",
        ".el-table__body tr",
        "[class*='ant-table-tbody'] tr",
        "[class*='data-list'] > div",
        "[class*='task-item']",
        "[class*='homework-item']",
        "[class*='todo-item']",
    ]
    seen: set[str] = set()
    out: list[HomeworkItem] = []
    hard_cap = 100_000 if max_items is None else max_items
    for sel in selectors:
        try:
            loc = page.locator(sel)
            cnt = loc.count()
            if cnt == 0 or cnt > 5000:
                continue
            n_take = min(cnt, hard_cap)
            for i in range(n_take):
                row = loc.nth(i)
                raw = _text(row)
                if not raw or len(raw) < 8:
                    continue
                if not _raw_looks_like_assignment_row(raw):
                    continue
                key = raw[:160]
                if key in seen:
                    continue
                seen.add(key)
                lines = [x.strip() for x in raw.split("\n") if x.strip()]
                title = lines[0][:200] if lines else raw[:200]
                due = ""
                for line in lines:
                    if _looks_like_due_line(line):
                        due = line[:160]
                        break
                    if re.search(r"\d{4}\s*[-年./]\s*\d{1,2}\s*[-月./]\s*\d{1,2}", line):
                        due = line[:160]
                        break
                if not due:
                    m = re.search(
                        r"(截止|提交时间|提交期限|逾期|剩余)[^\n]{0,100}(\d{4}[-年./]\s*\d{1,2}[-月./]\s*\d{1,2}[^\n]*)",
                        raw,
                        re.DOTALL,
                    )
                    if m:
                        due = m.group(0).strip()[:160]
                course = lines[1][:80] if len(lines) >= 2 and len(lines[1]) < 100 else ""
                link = _first_row_link(page, row)
                out.append(
                    HomeworkItem(
                        title=title or "（无标题）",
                        course=course,
                        due=due or "",
                        raw=raw[:500],
                        url=link,
                    )
                )
                if max_items is not None and len(out) >= max_items:
                    return out
        except Exception:
            continue
    return out


def extract_from_full_body(page: Page, parse_body_chars: int) -> list[HomeworkItem]:
    """启发式未命中时，用整页 innerText 再解析一轮。"""
    try:
        body = _text(page.locator("body"))
        if not body:
            return []
        blob = body[:parse_body_chars]
        items = parse_todo_panel_blob(blob)
        if not items:
            items = parse_loose_deadline_pairs(blob)
        return expand_combined_todo_items(items)
    except Exception:
        return []


def extract_via_dom_walk(page: Page, max_items: int | None) -> list[HomeworkItem]:
    """在浏览器内枚举列表/卡片/tr 等节点 innerText（应对 Vue/React 动态渲染、class 不固定）。"""
    block_max = 450 if max_items is None else min(450, max(80, max_items + 80))
    text_max = 2600
    try:
        chunks = page.evaluate(
            """({ blockMax, textMax }) => {
            const kw = /[\\u4e00-\\u9fff]{1,40}(作业|任务|测验|考试|问卷|预习|实验|报告|讨论)|待办|未完成|已截止|未提交|课程作业|课堂测验|线上作业/;
            const seen = new Set();
            const out = [];
            const push = (t) => {
              const s = (t || '').trim();
              if (!kw.test(s) || s.length < 14 || s.length > textMax) return;
              const k = s.slice(0, 130);
              if (seen.has(k)) return;
              seen.add(k);
              out.push(s);
            };
            const narrowSel =
              'main article, main section, table tbody tr, .el-table__body tr, [class*="table"] tbody tr, [class*="list-item"], [class*="List"] > div, [class*="card"], [class*="Card"], [role="listitem"], li';
            document.querySelectorAll(narrowSel).forEach((el) => {
              if (out.length >= blockMax) return;
              try { push(el.innerText); } catch (e) {}
            });
            if (out.length < 8) {
              document.querySelectorAll('div').forEach((el) => {
                if (out.length >= blockMax) return;
                try {
                  if (el.children.length > 18) return;
                  push(el.innerText);
                } catch (e) {}
              });
            }
            return out;
          }""",
            {"blockMax": block_max, "textMax": text_max},
        )
    except Exception:
        return []
    if not isinstance(chunks, list):
        return []
    seen: set[str] = set()
    out: list[HomeworkItem] = []
    for raw in chunks:
        if not isinstance(raw, str):
            continue
        raw = raw.strip()
        if len(raw) < 12:
            continue
        key = raw[:140]
        if key in seen:
            continue
        seen.add(key)
        lines = [x.strip() for x in raw.split("\n") if x.strip()]
        title = lines[0][:200] if lines else raw[:200]
        due = ""
        for line in lines:
            if _looks_like_due_line(line):
                due = line[:160]
                break
            if re.search(r"\d{4}\s*[-年./]\s*\d{1,2}\s*[-月./]\s*\d{1,2}", line):
                due = line[:160]
                break
        if not due:
            m = re.search(
                r"(截止|提交时间|提交期限|逾期|剩余)[^\n]{0,140}",
                raw,
                re.DOTALL,
            )
            if m:
                due = m.group(0).strip()[:160]
        course = lines[1][:80] if len(lines) > 1 else ""
        out.append(
            HomeworkItem(
                title=title or "（无标题）",
                course=course,
                due=due or "",
                raw=raw[:500],
                url="",
            )
        )
        if max_items is not None and len(out) >= max_items:
            break
    return out


def extract_heuristic(page: Page, max_items: int | None) -> list[HomeworkItem]:
    candidates = [
        "[class*='homework']",
        "[class*='Homework']",
        "[class*='task']",
        "[class*='assignment']",
        "[class*='work-item']",
        "[class*='todo']",
        "[class*='Todo']",
        ".el-card",
        "[class*='card']",
        "li[class*='item']",
        "div[class*='list'] > div",
    ]
    seen: set[str] = set()
    out: list[HomeworkItem] = []
    hard_cap = 100_000 if max_items is None else max_items
    for sel in candidates:
        try:
            loc = page.locator(sel)
            cnt = loc.count()
            if cnt == 0 or cnt > 12_000:
                continue
            n_take = min(cnt, hard_cap)
            for i in range(n_take):
                raw = _text(loc.nth(i))
                if not raw or len(raw) < 4:
                    continue
                if not _heuristic_text_matches_todo(raw):
                    continue
                key = raw[:120]
                if key in seen:
                    continue
                seen.add(key)
                lines = [x.strip() for x in raw.split("\n") if x.strip()]
                title = lines[0][:200] if lines else raw[:200]
                due = ""
                for line in lines:
                    if _looks_like_due_line(line):
                        due = line[:120]
                        break
                    if re.search(r"截止|提交期限|提交时间|逾期|due", line, re.I):
                        due = line[:120]
                        break
                course = lines[1] if len(lines) > 1 and len(lines[1]) < 60 else ""
                row_el = loc.nth(i)
                link = _first_row_link(page, row_el)
                out.append(HomeworkItem(title=title, course=course, due=due, raw=raw[:500], url=link))
                if max_items is not None and len(out) >= max_items:
                    return out
        except Exception:
            continue
    return out


def _run_extraction_strategies(
    page: Page,
    cfg: dict[str, Any],
    *,
    item_sel: str,
    title_rel: str,
    due_rel: str,
    max_items: int | None,
    parse_body_chars: int,
) -> list[HomeworkItem]:
    """按顺序尝试多种解析方式，合并前先做展开。"""
    items: list[HomeworkItem] = []
    if item_sel:
        items = extract_with_selector(page, item_sel, title_rel, due_rel, max_items)
    if not items:
        items = extract_heuristic(page, max_items)
    if not items:
        items = extract_table_like_rows(page, max_items)
    items = expand_combined_todo_items(items)

    if len(items) == 1 and items[0].raw.count("截止") > 1:
        try:
            body = _text(page.locator("body"))
            blob = body[:parse_body_chars] if body else ""
            more = parse_todo_panel_blob(blob)
            if len(more) > len(items):
                items = more
        except Exception:
            pass

    if not items:
        items = extract_from_full_body(page, parse_body_chars)

    if not items:
        try:
            for frame in page.frames:
                if frame == page.main_frame:
                    continue
                try:
                    fb = _text(frame.locator("body"))
                    if fb and len(fb) > 200:
                        items = expand_combined_todo_items(
                            parse_todo_panel_blob(fb[:parse_body_chars])
                        )
                        if not items:
                            items = expand_combined_todo_items(
                                parse_loose_deadline_pairs(fb[:parse_body_chars])
                            )
                        if items:
                            break
                except Exception:
                    continue
        except Exception:
            pass

    if not items:
        items = extract_via_dom_walk(page, max_items)

    items = expand_combined_todo_items(items)
    items = _filter_junk_items(items)
    return items
