"""
从北邮云邮教学空间学生端抓取作业列表（需已登录）。
页面为 SPA，使用 Playwright 持久化 profile 保存登录态。
"""
from __future__ import annotations

import base64
import json
import re
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, unquote
import yaml
from playwright.sync_api import Page, Response, sync_playwright

from extraction import (
    _dedupe_homework_items,
    _filter_junk_items,
    _first_row_link,
    _heuristic_text_matches_todo,
    _items_from_network_bucket,
    _looks_like_due_line,
    _max_items_cap,
    _raw_looks_like_assignment_row,
    _run_extraction_strategies,
    _text,
    expand_combined_todo_items,
    extract_from_full_body,
    extract_heuristic,
    extract_homework_from_json_tree,
    extract_table_like_rows,
    extract_via_dom_walk,
    extract_with_selector,
    parse_loose_deadline_pairs,
    parse_todo_panel_blob,
    scroll_to_load_lazy_content,
)
from logger import info, warn, error
from models import CACHE_SCHEMA_VERSION, HomeworkItem
from paths import DATA_DIR, SCRIPT_DIR

CONFIG_PATH = DATA_DIR / "config.yaml"
CACHE_PATH = DATA_DIR / "homework_cache.json"
COURSE_CACHE_PATH = DATA_DIR / "course_cache.json"
EXAMPLE_CONFIG = SCRIPT_DIR / "config.example.yaml"
# 由 Electron 内登录页导出，供 Playwright 复用 cookies（避免单独开 Chromium 登录）
STORAGE_STATE_PATH = DATA_DIR / "playwright_storage_state.json"


def load_config() -> dict[str, Any]:
    if not CONFIG_PATH.is_file():
        if EXAMPLE_CONFIG.is_file():
            CONFIG_PATH.write_text(EXAMPLE_CONFIG.read_text(encoding="utf-8"), encoding="utf-8")
        else:
            raise FileNotFoundError("缺少 config.yaml 与 config.example.yaml")
    with CONFIG_PATH.open(encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}

    # 解密密码（Fernet 加密的 token 会自动解密）
    raw_pw = str(cfg.get("password") or "")
    if raw_pw:
        from crypto_utils import decrypt_password, is_encrypted
        if is_encrypted(raw_pw):
            try:
                cfg["password"] = decrypt_password(raw_pw)
            except Exception:
                pass  # 解密失败则保留原值（可能是损坏的 token）

    # 环境变量覆盖（优先级高于 config.yaml）
    import os
    env_user = os.getenv("BUPT_USERNAME") or os.getenv("BUPT_UCLASS_USERNAME")
    env_pass = os.getenv("BUPT_PASSWORD") or os.getenv("BUPT_UCLASS_PASSWORD")
    if env_user:
        cfg["username"] = env_user
        cfg["auto_login"] = cfg.get("auto_login", True)
    if env_pass:
        cfg["password"] = env_pass
        cfg["auto_login"] = cfg.get("auto_login", True)

    return cfg


def resolve_portal_url(cfg: dict[str, Any]) -> str:
    u = cfg.get("target_url") or cfg.get("login_start_url") or ""
    return str(u).strip() if u else ""


def resolve_alternate_urls(cfg: dict[str, Any]) -> list[str]:
    """额外尝试的页面 URL（待办不在首页时常用）。"""
    raw = cfg.get("alternate_target_urls") or cfg.get("extra_target_urls")
    if not raw:
        return []
    if isinstance(raw, str):
        lines = [x.strip() for x in raw.replace("\n", ",").split(",") if x.strip()]
        return lines
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    return []


def _network_capture_url_ok(url: str, cfg: dict[str, Any]) -> bool:
    subs = cfg.get("network_capture_url_substrings")
    if subs is None:
        subs = [
            "ucloud.bupt.edu.cn",
            "bupt.edu.cn",
            "uclass",
            "/api/",
            "homework",
            "task",
            "activity",
            "todo",
            "student",
        ]
    elif isinstance(subs, str):
        subs = [subs]
    else:
        subs = list(subs)
    u = url.lower()
    return any(s.lower() in u for s in subs if s)


def _attach_network_json_capture(
    page: Page,
    bucket: list[dict[str, Any]],
    cfg: dict[str, Any],
    *,
    debug_dump: bool = False,
    debug_all_bucket: list[dict[str, Any]] | None = None,
) -> None:
    """监听 HTTP 响应的 JSON/XHR/fetch 等（平台课业数据多在接口里）。

    非 debug 模式仅捕获疑似 API 的 JSON 响应写入 *bucket*；
    debug 模式下同时将所有 HTTP 响应写入 *debug_all_bucket*（用于诊断 API 端点）。
    """

    def on_response(response: Response) -> None:
        try:
            req = response.request
            rt = req.resource_type or ""
            url = response.url
            status = response.status

            # debug 模式：记录所有 bupt/ucloud 请求到诊断桶
            if debug_dump and debug_all_bucket is not None and ("ucloud" in url or "bupt" in url or "api" in url.lower()):
                ct = (response.headers.get("content-type") or "").lower()
                body_preview = ""
                try:
                    body = response.body()
                    if len(body) < 200_000:
                        body_preview = body.decode("utf-8", errors="replace")[:3000]
                except Exception:
                    pass
                debug_all_bucket.append({
                    "url": url[:500],
                    "status": status,
                    "resource_type": rt,
                    "content_type": ct[:200],
                    "method": req.method,
                    "body_preview": body_preview[:2000],
                })
                if "ucloud" in url or "bupt" in url:
                    info(f"[网络] {rt:12} {status} {url[:120]}")

            # 仅关注可能含数据的请求类型（放宽条件，也捕获 preflight/doc 以外的所有类型）
            if rt in ("preflight", "ping", "csp_report", "media", "image", "font", "stylesheet"):
                return
            if not _network_capture_url_ok(url, cfg):
                return
            ct = (response.headers.get("content-type") or "").lower()
            cl = response.headers.get("content-length")
            if cl and int(cl) > 6_000_000:
                return
            body = response.body()
            if len(body) > 5_000_000:
                return
            text = body.decode("utf-8", errors="replace").strip()
            if not text or text[0] not in "{[":
                return
            looks_json = "json" in ct or url.split("?")[0].lower().endswith(".json")
            if not looks_json and len(text) > 2_000_000:
                return
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                return
            bucket.append({"url": url, "data": data, "status": status})
            info(f"[捕获接口] {status} {url[:130]}")
        except Exception:
            return

    page.on("response", on_response)


def _detect_login_state(page: Page) -> dict[str, Any]:
    """检测当前页面登录状态。返回包含 is_logged_in 等字段的字典。"""
    result: dict[str, Any] = {"is_logged_in": False, "reason": "unknown", "page_url": page.url}
    try:
        title = page.title()
        result["page_title"] = title

        # 检查是否 SPA 显示 404（路由无效或未登录导致）
        try:
            not_found = page.locator(".not-found")
            if not_found.count() > 0 and not_found.first.is_visible():
                result["reason"] = "spa_showing_404_page"
                result["hint"] = "SPA 显示 404，可能是登录态已过期导致所有路由失效。请在应用内重新登录后重试。"
                return result
        except Exception:
            pass

        # 检查 URL 是否重定向到 CAS/统一认证登录
        current_url = page.url.lower()
        # 旧 CAS URL (cas.bupt.edu.cn) 或新 auth 服务器 (auth.bupt.edu.cn/authserver)
        if ("cas" in current_url or "authserver" in current_url) and ("login" in current_url or "auth" in current_url):
            result["reason"] = "redirected_to_cas_login"
            return result
        if "login" in current_url and "passport" in current_url:
            result["reason"] = "redirected_to_passport_login"
            return result

        # 检查页面元素：是否有登录按钮/表单
        login_indicators = [
            "input[type='password']",
            "button:has-text('登录')",
            "a:has-text('登录')",
            ".login-btn",
            "#login",
            "[class*='login']",
        ]
        for sel in login_indicators:
            try:
                el = page.locator(sel)
                if el.count() > 0 and el.first.is_visible():
                    result["reason"] = f"found_login_element: {sel}"
                    return result
            except Exception:
                continue

        # 检查是否有用户信息元素（表示已登录）
        user_indicators = [
            "[class*='avatar']",
            "[class*='user']",
            "[class*='nickname']",
            ".el-avatar",
            "img[alt*='头像']",
        ]
        has_user_element = False
        for sel in user_indicators:
            try:
                el = page.locator(sel)
                if el.count() > 0 and el.first.is_visible():
                    has_user_element = True
                    break
            except Exception:
                continue

        if has_user_element:
            result["is_logged_in"] = True
            result["reason"] = "found_user_element"
        else:
            result["reason"] = "no_login_or_user_elements_found"
    except Exception as e:
        result["reason"] = f"detection_error: {e}"

    return result


def _post_goto_networkidle(page: Page, cfg: dict[str, Any]) -> None:
    """SPA 常见：接口晚于 domcontentloaded，等待网络空闲再解析。"""
    if not cfg.get("after_goto_wait_networkidle", True):
        return
    try:
        to = int(cfg.get("networkidle_timeout_ms", 22_000))
        to = max(5_000, min(to, 120_000))
        page.wait_for_load_state("networkidle", timeout=to)
    except Exception:
        pass


def _resolve_user_data(cfg: dict[str, Any]) -> Path:
    raw = cfg.get("user_data_dir") or "browser_profile"
    p = Path(raw)
    if p.is_absolute():
        return p
    return DATA_DIR / p


def _use_playwright_storage_state(cfg: dict[str, Any]) -> bool:
    if not cfg.get("use_playwright_storage_state", True):
        return False
    return STORAGE_STATE_PATH.is_file()


def _resolve_student_page_urls(cfg: dict[str, Any]) -> list[str]:
    """收集所有可能需要尝试的学生页面 hash 路由。"""
    base = "https://ucloud.bupt.edu.cn/uclass/index.html"
    # 从配置读取
    target = resolve_portal_url(cfg)
    urls: list[str] = [target] if target else []

    # 追加备选
    for u in resolve_alternate_urls(cfg):
        if u and u not in urls:
            urls.append(u)

    # 追加常见的课业相关 hash 路由
    candidate_hashes = [
        "#/student/homePage",
        "#/student/homework",
        "#/student/task",
        "#/student/taskList",
        "#/student/course",
        "#/student/courseList",
        "#/student/activity",
        "#/student/myHomework",
        "#/student/assignment",
        "#/student/todo",
        "#/student/index",
    ]
    for h in candidate_hashes:
        u = f"{base}{h}"
        if u not in urls:
            urls.append(u)

    # 也尝试从首页自动导航（由下面的导航逻辑处理）
    home_url = f"{base}#/"
    if home_url not in urls:
        urls.append(home_url)

    return urls


def _fetch_api_from_page(page: Page, url: str) -> dict | None:
    """从已登录的 page 上下文发起 fetch 请求（自动携带 cookie）。"""
    try:
        result = page.evaluate(
            """
            async (url) => {
                try {
                    const resp = await fetch(url, { credentials: 'include' });
                    if (!resp.ok) return null;
                    return await resp.json();
                } catch(e) { return null; }
            }
            """,
            url,
        )
        if isinstance(result, dict):
            return result
        return None
    except Exception:
        return None


def _paginate_api(
    page: Page,
    base_url: str,
    list_key: str = "records",
    total_key: str = "total",
    page_size: int = 100,
) -> list[dict[str, Any]]:
    """分页获取 API 全部数据。

    支持两种分页结构：
    - 标准分页: {records, total, size, current, pages}
    - undone 接口: {undoneList, undoneNum}

    先尝试带分页参数；若第 1 页失败则退回到原 URL（可能不分页，一次性返回全部）。
    """
    all_items: list[dict[str, Any]] = []
    current = 1

    while True:
        sep = "&" if "?" in base_url else "?"
        url = f"{base_url}{sep}current={current}&size={page_size}"
        result = _fetch_api_from_page(page, url)
        if (not result or result.get("code") != 200) and current == 1:
            # 分页参数可能不支持，退回到原 URL 一次性获取
            result = _fetch_api_from_page(page, base_url)

        if not result or result.get("code") != 200:
            break

        data = result.get("data", {})
        items = data.get(list_key, [])
        if not items:
            break

        if isinstance(items, list):
            all_items.extend(items)
        else:
            break

        total = data.get(total_key, 0)

        if total > 0 and len(all_items) >= total:
            break
        if len(items) < page_size:
            break

        # 安全阀：若 API 忽略分页参数、每次返回相同条目，避免重复累积
        if current == 1:
            _first_page_ids = {
                str(it.get("activityId") or it.get("id") or hash(json.dumps(it, sort_keys=True)))
                for it in items[:3]
            }
        else:
            _this_page_ids = {
                str(it.get("activityId") or it.get("id") or hash(json.dumps(it, sort_keys=True)))
                for it in items[:3]
            }
            if _this_page_ids == _first_page_ids:
                break

        current += 1
        if current > 100:
            break

    return all_items


def _get_user_id(page: Page, net_bucket: list[dict[str, Any]], iclass_token: str = "") -> str:
    """多路获取 userId：JWT 解码 → 用户信息 API → net_bucket → localStorage。"""
    # 1) Decode JWT (iclass_token)
    if iclass_token:
        try:
            payload = iclass_token.split(".")[1]
            payload += "=" * (4 - len(payload) % 4)
            data = json.loads(base64.b64decode(payload).decode("utf-8"))
            uid = str(data.get("user_id") or data.get("userId") or data.get("sub") or "")
            if uid:
                info(f"[userId] 从 JWT 获取: {uid[:8]}...")
                return uid
        except Exception:
            pass

    # 2) 从 net_bucket 的课程列表 API URL 提取
    for row in net_bucket:
        m = re.search(r"userId=(\d+)", row.get("url", ""))
        if m:
            uid = m.group(1)
            info(f"[userId] 从 net_bucket 获取: {uid[:8]}...")
            return uid

    # 3) 调用用户信息 API
    try:
        api_base = _resolve_api_base(net_bucket)
        resp = page.evaluate(
            f"""async () => {{
            const r = await fetch('{api_base}/ykt-basics/info', {{credentials: 'include'}});
            const d = await r.json();
            return d?.data?.id || d?.id || '';
        }}"""
        )
        if resp:
            info(f"[userId] 从 info API 获取: {str(resp)[:8]}...")
            return str(resp)
    except Exception:
        pass

    # 4) Fallback: localStorage
    try:
        uid = page.evaluate(
            """() => {
            try {
                const store = JSON.parse(localStorage.getItem('store') || '{}');
                return store.user_id || store.userId || null;
            } catch(e) { return null; }
        }"""
        )
        if uid:
            info(f"[userId] 从 localStorage 获取: {str(uid)[:8]}...")
            return str(uid)
    except Exception:
        pass

    return ""


def _resolve_api_base(net_bucket: list[dict[str, Any]]) -> str:
    for row in net_bucket:
        url = row.get("url", "")
        m = re.match(r"(https?://[^/]+)", url)
        if m and "api" in url.lower():
            return m.group(1)
    return "https://apiucloud.bupt.edu.cn"


def _get_course_count(page: Page, net_bucket: list[dict[str, Any]]) -> int:
    """从网络捕获或直接 API 调用获取当前学期课程门数。"""
    # Step 1: 尝试从 net_bucket 中找课程列表 API 的响应
    for row in net_bucket:
        url = row.get("url", "")
        if "/site/list/student/current" in url:
            data = row.get("data", {})
            inner = (data.get("data") if isinstance(data, dict) else None) or {}
            records = inner.get("records", [])
            if records:
                info(f"[课程计数] 从网络捕获获取到 {len(records)} 门课程")
                return len(records)

    # Step 2: 直接调用课程列表 API
    api_base = _resolve_api_base(net_bucket)

    result = _fetch_api_from_page(
        page,
        f"{api_base}/ykt-site/site/list/student/current?siteRoleCode=2&size=999&current=1",
    )
    if result and isinstance(result, dict) and result.get("code") == 200:
        inner = (result.get("data") if isinstance(result, dict) else None) or {}
        records = inner.get("records", [])
        if records:
            info(f"[课程计数] 从 API 获取到 {len(records)} 门课程")
            return len(records)

    warn("[课程计数] 未能获取课程数")
    return 0


def _get_courses(page: Page, net_bucket: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str]:
    """获取课程列表（含 siteName）和 userId。先从 net_bucket 提取，失败再调 API。"""
    # 提取 iclass_token 用于 JWT 解码获取 userId
    ic_token = ""
    for row in net_bucket:
        url = row.get("url", "")
        if "/site/list/student/current" in url or "ykt-site" in url:
            headers_raw = row.get("headers") or row.get("requestHeaders") or {}
            ic_token = headers_raw.get("Blade-Auth") or headers_raw.get("blade-auth") or ""
            if ic_token:
                break

    user_id = _get_user_id(page, net_bucket, ic_token)

    # Step 1: 从 net_bucket 提取课程列表
    for row in net_bucket:
        url = row.get("url", "")
        if "/site/list/student/current" in url:
            data = row.get("data", {})
            inner = (data.get("data") if isinstance(data, dict) else None) or {}
            records = inner.get("records", [])
            if records:
                info(f"[全量作业] 从网络捕获获取到 {len(records)} 门课程")
                return records, user_id

    # Step 2: Fallback 直接调 API（不强制要 userId）
    api_base = _resolve_api_base(net_bucket)
    params = "?siteRoleCode=2&size=999&current=1"
    if user_id:
        params = f"?userId={user_id}&siteRoleCode=2&size=999&current=1"
    result = _fetch_api_from_page(page, f"{api_base}/ykt-site/site/list/student/current{params}")
    if result and isinstance(result, dict) and result.get("code") == 200:
        records = result.get("data", {}).get("records", [])
        if records:
            info(f"[全量作业] 从 API 获取到 {len(records)} 门课程")
            return records, user_id

    warn("[全量作业] 未能获取课程列表")
    return [], user_id


def _fetch_all_course_work_items(
    page: Page,
    context,
    courses: list[dict[str, Any]],
    user_id: str,
) -> list[dict[str, Any]]:
    """逐课调用 work/student/list，收集全部作业记录（含已提交）。"""
    # 从 context cookies 提取 iClass-token (JWT)
    iclass_token = ""
    try:
        for c in context.cookies():
            if c.get("name") == "iClass-token":
                iclass_token = c.get("value", "")
                break
    except Exception:
        pass

    all_records: list[dict[str, Any]] = []
    api = context.request

    for idx, course in enumerate(courses):
        site_id = course.get("id", "")
        site_name = course.get("siteName", "")
        if not site_id:
            continue
        try:
            records: list[dict[str, Any]] = []
            current = 1
            while True:
                headers = {}
                if iclass_token:
                    headers["Blade-Auth"] = iclass_token
                resp = api.post(
                    "https://apiucloud.bupt.edu.cn/ykt-site/work/student/list",
                    data={
                        "siteId": site_id,
                        "userId": user_id,
                        "current": str(current),
                        "size": "200",
                    },
                    headers=headers,
                )
                if resp.status != 200:
                    break
                data = resp.json()
                if not isinstance(data, dict):
                    break
                inner = (data.get("data") if isinstance(data, dict) else None) or {}
                page_records = inner.get("records", [])
                if not page_records:
                    break
                records.extend(page_records)
                total = inner.get("total", 0)
                if total > 0 and len(records) >= total:
                    break
                if len(page_records) < 200:
                    break
                current += 1
                if current > 100:
                    break

            for rec in records:
                rec["_course_name"] = site_name
                rec["_site_id"] = str(site_id)
            all_records.extend(records)
            info(f"[全量作业] [{idx+1}/{len(courses)}] {site_name}: {len(records)} 条")
        except Exception as e:
            warn(f"[全量作业] [{idx+1}/{len(courses)}] {site_name} 获取失败: {e}")
            continue

    info(f"[全量作业] 总共获取 {len(all_records)} 条工作记录")
    return all_records


def _convert_work_records_to_items(
    work_records: list[dict[str, Any]],
    undone_ids: set[str],
) -> list[HomeworkItem]:
    """将 per-course 工作记录转为 HomeworkItem，标记提交状态和课程名。"""
    items: list[HomeworkItem] = []
    for rec in work_records:
        activity_id = str(rec.get("id") or rec.get("activityId", ""))

        # 优先用 extract_homework_from_json_tree 解析
        extracted = extract_homework_from_json_tree(rec, source_url="")
        if extracted:
            for ex in extracted:
                if not ex.course:
                    ex.course = str(rec.get("_course_name", ""))
                if not ex.assignment_id:
                    ex.assignment_id = str(activity_id)
                if not ex.submitted and undone_ids and activity_id:
                    ex.submitted = activity_id not in undone_ids
                # 如果已经从 work/detail 获取了内容，填充到 item
                ac = rec.get("assignmentContent", "") or ""
                if ac and not ex.content:
                    ex.content = ac[:20000]
                items.append(ex)
        else:
            # Fallback: 直接从已知字段构建
            title = str(rec.get("workName") or rec.get("activityName")
                       or rec.get("title") or rec.get("name", "")).strip()
            if not title or len(title) < 2:
                continue
            due = str(rec.get("endTime") or rec.get("deadline")
                     or rec.get("closeTime") or rec.get("submitEnd", "")).strip()
            course = str(rec.get("_course_name", ""))
            content = str(rec.get("assignmentContent") or rec.get("content")
                         or rec.get("description") or rec.get("introduction")
                         or rec.get("workContent") or rec.get("remark", "")).strip()
            submitted = bool(undone_ids and activity_id and activity_id not in undone_ids)

            items.append(HomeworkItem(
                title=title[:500],
                course=course[:200],
                due=due[:220],
                raw=json.dumps(rec, ensure_ascii=False)[:500],
                url="",
                submitted=submitted,
                content=content[:3000] if content else "",
                assignment_id=str(activity_id),
            ))

    return _dedupe_homework_items(items)


def _enrich_work_records_with_details(
    context,
    work_records: list[dict[str, Any]],
    iclass_token: str,
    *,
    max_concurrent: int = 5,
) -> list[dict[str, Any]]:
    """逐条调用 work/detail 获取 assignmentContent 等详情，原地 enrich 每一条 record。

    返回被 enrich 的 work_records（新字段: assignmentContent, assignmentComment）。
    """
    if not work_records or not iclass_token:
        return work_records

    headers = {"Blade-Auth": iclass_token}
    api = context.request
    enriched = 0
    failed = 0

    for i, rec in enumerate(work_records):
        aid = rec.get("id") or rec.get("activityId", "")
        if not aid:
            continue
        try:
            resp = api.get(
                f"https://apiucloud.bupt.edu.cn/ykt-site/work/detail",
                params={"assignmentId": aid},
                headers=headers,
            )
            if resp.status == 200:
                data = resp.json()
                detail = (data.get("data") if isinstance(data, dict) else None) or {}
                content = detail.get("assignmentContent", "") or ""
                comment = detail.get("assignmentComment", "") or ""
                if content or comment:
                    rec["assignmentContent"] = content[:15000]
                    rec["assignmentComment"] = comment[:3000]
                    enriched += 1
                resources = detail.get("assignmentResource")
                if resources:
                    rec["assignmentResource"] = resources
            else:
                failed += 1
        except Exception:
            failed += 1

        if (i + 1) % 20 == 0:
            info(f"[作业详情] 已获取 {enriched}/{i+1} 条详情...")

    info(f"[作业详情] 完成: {enriched} 条成功, {failed} 条失败")
    return work_records


def _save_auth_token(iclass_token: str) -> None:
    """将 iClass 认证令牌保存到文件，供 Electron 主进程下载资源时使用。"""
    if not iclass_token:
        return
    try:
        auth = {
            "iclass_token": iclass_token,
            "authorization": "Basic c3dvcmQ6c3dvcmRfc2VjcmV0",
            "tenant_id": "000000",
            "api_base": "https://apiucloud.bupt.edu.cn",
        }
        (DATA_DIR / "auth_tokens.json").write_text(
            json.dumps(auth, ensure_ascii=False), encoding="utf-8"
        )
    except Exception as e:
        warn(f"[认证] 保存令牌失败: {e}")


def _download_attachments(
    context,
    work_records: list[dict[str, Any]],
    iclass_token: str,
) -> list[dict[str, Any]]:
    """解析作业内容中的附件链接，下载附件到本地并替换路径。"""
    if not work_records or not iclass_token:
        return work_records

    # 保存令牌供 Electron 使用
    _save_auth_token(iclass_token)

    headers = {"Blade-Auth": iclass_token}
    api = context.request
    ATTACHMENT_HOST = "fileucloud.bupt.edu.cn"
    downloaded = 0
    failed = 0

    for rec in work_records:
        content = rec.get("assignmentContent", "") or ""
        aid = rec.get("id") or rec.get("activityId", "")
        if not aid:
            continue
        att_dir = DATA_DIR / "attachments" / str(aid)
        att_dir.mkdir(parents=True, exist_ok=True)

        # ---- 1) 处理 assignmentContent HTML 中的附件 URL ----
        if content:
            urls = set(re.findall(
                r'(https?://' + re.escape(ATTACHMENT_HOST) + r'[^\s"\'<>&]+)',
                content,
            ))
            for url in urls:
                try:
                    resp = api.get(url, headers=headers)
                    if resp.status != 200:
                        failed += 1
                        continue

                    # 从 Content-Disposition 或 URL 中提取文件名
                    cd = resp.headers.get("content-disposition", "")
                    filename = ""
                    if cd:
                        m = re.search(r'filename\*?=(?:UTF-8\'\')?([^;\s]+)', cd)
                        if m:
                            filename = unquote(m.group(1).strip().strip("'\""))
                    if not filename:
                        parsed = urlparse(url)
                        filename = unquote(Path(parsed.path).name)
                    if not filename:
                        filename = f"attachment_{len(list(att_dir.iterdir()))}"

                    filename = re.sub(r'[\\/:*?"<>|]', '_', filename)
                    file_path = att_dir / filename
                    file_path.write_bytes(resp.body())
                    content = content.replace(url, "attachment:///" + file_path.as_posix())
                    downloaded += 1
                    info(f"[附件] 已下载: {filename} ({aid})")
                except Exception as e:
                    failed += 1
                    warn(f"[附件] 下载失败: {url[:80]}... {e}")

        # ---- 2) 处理 assignmentResource（教师上传的附件：贴下载链接，不预下载） ----
        resources = rec.get("assignmentResource", [])
        if isinstance(resources, list):
            for res in resources:
                rid = res.get("resourceId", "")
                rname = res.get("resourceName", "") or f"附件_{rid}"
                if not rid:
                    continue
                is_img = bool(re.search(r'\.(png|jpe?g|gif|bmp|webp|svg)$', rname, re.I))
                if is_img:
                    link_html = (
                        f'<p><a href="#resource-dl" class="resource-download" '
                        f'data-resource-id="{rid}" data-resource-name="{rname}">'
                        f'&#x1F5BC; {rname}</a> '
                        f'<span class="resource-dl-hint">（点击下载）</span></p>'
                    )
                else:
                    link_html = (
                        f'<p><a href="#resource-dl" class="resource-download" '
                        f'data-resource-id="{rid}" data-resource-name="{rname}">'
                        f'&#x1F4CE; {rname}</a></p>'
                    )
                if content:
                    content += "\n" + link_html
                else:
                    content = link_html

        rec["assignmentContent"] = content[:20000]

    info(f"[附件] 完成: {downloaded} 个成功, {failed} 个失败")
    return work_records


def _flatten_resource_tree(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """将资源树（chapter/section 节点含 attachmentVOs）展平为文件列表。"""
    files = []
    for node in nodes:
        # 提取当前节点的附件（实际文件）
        for att in node.get("attachmentVOs") or []:
            files.append(att)
        # 递归处理子节点
        for child in node.get("children") or []:
            files.extend(_flatten_resource_tree([child]))
    return files


def _fetch_course_resources(
    page,
    context,
    courses: list[dict[str, Any]],
    iclass_token: str,
) -> dict[str, list[dict[str, Any]]]:
    """获取课程级别的资源文件。

    已知的正确 API: POST /ykt-site/site-resource/tree/student?siteId={siteId}
    使用 Blade-Auth header（值为 iClass-token cookie）。
    返回 { site_id: [{resourceId, resourceName, fileSize, suffix}] }。
    """
    if not courses or not iclass_token:
        return {}

    api = context.request
    headers = {"Blade-Auth": iclass_token, "tenant-id": "000000"}
    base = "https://apiucloud.bupt.edu.cn"
    endpoint = "/ykt-site/site-resource/tree/student"

    result: dict[str, list[dict[str, Any]]] = {}

    for course in courses:
        sid = course.get("id", "")
        sn = course.get("siteName", "")
        if not sid:
            continue
        try:
            resp = api.post(f"{base}{endpoint}", params={"siteId": sid}, headers=headers)
            if resp.status == 200:
                raw_body = resp.body()
                data = json.loads(raw_body.decode("utf-8"))
                if data.get("success") and data.get("data"):
                    tree = data["data"]
                    if isinstance(tree, list):
                        files = _flatten_resource_tree(tree)
                    elif isinstance(tree, dict):
                        files = _flatten_resource_tree(tree.get("children") or tree.get("child") or [tree])
                    else:
                        files = []
                    if files:
                        result[sid] = _normalize_resources(files)
                        info(f"[课程资源] {sn}: {len(files)} 个资源")
                    else:
                        info(f"[课程资源] {sn}: 该课程无资源文件")
                else:
                    msg = data.get("msg", data.get("message", "未知错误"))
                    info(f"[课程资源] {sn}: 无资源数据 ({msg})")
            else:
                info(f"[课程资源] {sn}: HTTP {resp.status}")
        except Exception as e:
            warn(f"[课程资源] {sn}: 请求失败: {e}")
            continue

    total = sum(len(v) for v in result.values())
    if result:
        info(f"[课程资源] 共获取 {len(result)} 个课程的 {total} 个资源")
    else:
        info("[课程资源] 未获取到任何课程资源")
    return result


def _normalize_resources(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """规范化资源记录为统一格式。

    处理两种输入格式：
    - 资源树节点: {resourceName, children, attachmentVOs, ...}
    - 附件对象 (attachmentVO): {id, resource: {name, fileSize, ext, ...}, ...}
    """
    normalized = []
    for res in records:
        r = res.get("resource") or {}
        normalized.append({
            "resourceId": res.get("resourceId") or res.get("id", ""),
            "resourceName": (
                res.get("resourceName")
                or r.get("name")
                or res.get("originalName")
                or res.get("name")
                or res.get("fileName")
                or "未命名文件"
            ),
            "fileSize": r.get("fileSize") or res.get("fileSize") or res.get("size") or "",
            "suffix": r.get("ext") or res.get("suffix") or res.get("fileType") or res.get("ext") or "",
            "downloadUrl": r.get("url") or res.get("url") or res.get("downloadUrl") or "",
        })
    return normalized


def fetch_homework(
    headless: bool = True,
    debug_dump: bool = False,
    cfg: dict[str, Any] | None = None,
    mode: str = "all",
) -> list[HomeworkItem]:
    cfg = load_config() if cfg is None else cfg
    target = resolve_portal_url(cfg)
    if not target:
        raise ValueError("请在 config.yaml 中设置 target_url 或 login_start_url")

    wait_ms = int(cfg.get("post_load_wait_ms", 8000))
    nav_timeout_ms = int(cfg.get("navigation_timeout_ms", 120_000))
    user_data = _resolve_user_data(cfg)
    user_data.mkdir(parents=True, exist_ok=True)
    item_sel = (cfg.get("homework_item_selector") or "").strip()
    title_rel = (cfg.get("title_relative") or "").strip()
    due_rel = (cfg.get("due_relative") or "").strip()
    max_items = _max_items_cap(cfg)
    parse_body_chars = int(cfg.get("parse_body_max_chars", 500_000))
    parse_body_chars = max(5_000, min(parse_body_chars, 2_000_000))

    items: list[HomeworkItem] = []
    course_count = 0
    use_storage = _use_playwright_storage_state(cfg)

    urls_to_try = _resolve_student_page_urls(cfg)

    nav_errors: list[str] = []
    login_state: dict[str, Any] = {}
    debug_all_bucket: list[dict[str, Any]] = []

    try:
        with sync_playwright() as p:
            browser = None
            if use_storage:
                browser = p.chromium.launch(
                    headless=headless,
                    args=["--disable-blink-features=AutomationControlled"],
                )
                context = browser.new_context(
                    storage_state=str(STORAGE_STATE_PATH),
                    locale="zh-CN",
                    viewport={"width": 1400, "height": 900},
                )
            else:
                context = p.chromium.launch_persistent_context(
                    user_data_dir=str(user_data),
                    headless=headless,
                    locale="zh-CN",
                    viewport={"width": 1400, "height": 900},
                    args=["--disable-blink-features=AutomationControlled"],
                )
            try:
                page = context.new_page() if use_storage else (
                    context.pages[0] if context.pages else context.new_page()
                )
                net_bucket: list[dict[str, Any]] = []
                _attach_network_json_capture(
                    page, net_bucket, cfg,
                    debug_dump=debug_dump,
                    debug_all_bucket=debug_all_bucket,
                )

                wait_until = (cfg.get("page_goto_wait_until") or "domcontentloaded").strip()
                if wait_until not in ("commit", "domcontentloaded", "load", "networkidle"):
                    wait_until = "domcontentloaded"

                tried_hashes: set[str] = set()
                auto_login_attempted = False
                saved_courses: list[dict[str, Any]] = []
                course_resources: dict[str, list[dict[str, Any]]] = {}

                for nav_url in urls_to_try:
                    # 跳过已尝试过的相同 hash
                    nav_hash = nav_url.split("#")[-1] if "#" in nav_url else ""
                    if nav_hash in tried_hashes:
                        continue
                    tried_hashes.add(nav_hash)

                    try:
                        page.goto(nav_url, wait_until=wait_until, timeout=nav_timeout_ms)
                    except Exception as e:
                        nav_errors.append(f"{nav_url}: {e}")
                        continue

                    _post_goto_networkidle(page, cfg)
                    page.wait_for_timeout(wait_ms)

                    # 检测当前是否被重定向到首页
                    current_hash = page.evaluate("() => window.location.hash") or ""
                    if current_hash in ("", "#/", "#") and nav_hash not in ("", "/", ""):
                        info(f"[导航] 当前在首页({current_hash})，尝试跳转到学生页...")
                        page.goto(
                            f"https://ucloud.bupt.edu.cn/uclass/index.html#/student/homePage",
                            wait_until="domcontentloaded",
                            timeout=nav_timeout_ms,
                        )
                        _post_goto_networkidle(page, cfg)
                        page.wait_for_timeout(wait_ms)

                    # 滚动以触发懒加载
                    if cfg.get("scroll_before_extract", True):
                        scroll_to_load_lazy_content(
                            page,
                            rounds=int(cfg.get("scroll_rounds", 28)),
                            pause_ms=int(cfg.get("scroll_pause_ms", 400)),
                        )
                        extra = int(cfg.get("post_scroll_wait_ms", 1200))
                        if extra > 0:
                            page.wait_for_timeout(extra)

                    # 检测登录状态
                    login_state = _detect_login_state(page)
                    if debug_dump:
                        print(f"[登录检测] {login_state.get('reason')} (is_logged_in={login_state.get('is_logged_in')})", flush=True)

                    # 如果未登录且开启了自动登录，尝试自动填写凭据
                    if (
                        not login_state.get("is_logged_in")
                        and cfg.get("auto_login")
                        and not auto_login_attempted
                    ):
                        auto_login_attempted = True
                        from auto_login import perform_auto_login
                        from exceptions import LoginError, ConfigError

                        try:
                            if perform_auto_login(page, cfg):
                                print("[自动登录] 登录成功，重新导航到目标页...", flush=True)
                                net_bucket.clear()
                                try:
                                    page.goto(
                                        nav_url, wait_until=wait_until, timeout=nav_timeout_ms
                                    )
                                except Exception as e:
                                    print(f"[自动登录] 重新导航失败: {e}", flush=True)
                                _post_goto_networkidle(page, cfg)
                                page.wait_for_timeout(wait_ms)
                                if cfg.get("scroll_before_extract", True):
                                    scroll_to_load_lazy_content(
                                        page,
                                        rounds=int(cfg.get("scroll_rounds", 28)),
                                        pause_ms=int(cfg.get("scroll_pause_ms", 400)),
                                    )
                                    extra = int(cfg.get("post_scroll_wait_ms", 1200))
                                    if extra > 0:
                                        page.wait_for_timeout(extra)
                                login_state = _detect_login_state(page)
                                if debug_dump:
                                    print(
                                        f"[登录检测] 自动登录后: {login_state.get('reason')} "
                                        f"(is_logged_in={login_state.get('is_logged_in')})",
                                        flush=True,
                                    )
                        except ConfigError as e:
                            print(f"[自动登录] 配置错误: {e}", flush=True)
                            break
                        except LoginError as e:
                            print(f"[自动登录] 登录失败: {e}", flush=True)
                            break

                    # 若 SPA 显示 404 且无任何 API 请求，提前终止（登录态过期）
                    if login_state.get("reason") == "spa_showing_404_page" and len(net_bucket) == 0:
                        warn("[诊断] 页面显示 404，且无 API 请求。登录态很可能已过期，请重新登录。")
                        break

                    if debug_dump:
                        # 写入页面 DOM 和截图
                        DATA_DIR.mkdir(parents=True, exist_ok=True)
                        (DATA_DIR / "debug_page.html").write_text(
                            page.content(), encoding="utf-8"
                        )
                        page.screenshot(path=str(DATA_DIR / "debug_page.png"), full_page=True)

                        # 写入全面的网络诊断文件
                        net_debug = DATA_DIR / "debug_network.json"
                        net_debug.write_text(
                            json.dumps({
                                "page_url": page.url,
                                "page_title": page.title(),
                                "target_url": nav_url,
                                "captured_api_count": len(net_bucket),
                                "captured_all_count": len(debug_all_bucket),
                                "login_state": login_state,
                                "api_requests": [
                                    {"url": r.get("url"), "status": r.get("status"),
                                     "data_type": type(r.get("data")).__name__,
                                     "data_preview": str(r.get("data"))[:500]}
                                    for r in net_bucket[:50]
                                ],
                                "all_requests": debug_all_bucket[:200],
                            }, ensure_ascii=False, indent=2),
                            encoding="utf-8",
                        )
                        print(f"[调试] 页面URL: {page.url}", flush=True)
                        print(f"[调试] 页面标题: {page.title()}", flush=True)
                        print(f"[调试] 捕获到 {len(net_bucket)} 个接口请求 / {len(debug_all_bucket)} 个总请求", flush=True)

                    # ---- DOM 提取 ----
                    dom_items = _run_extraction_strategies(
                        page,
                        cfg,
                        item_sel=item_sel,
                        title_rel=title_rel,
                        due_rel=due_rel,
                        max_items=None,  # DOM 不限条数，最后统一截断
                        parse_body_chars=parse_body_chars,
                    )

                    # ---- API 提取（含分页） ----
                    api_items: list[HomeworkItem] = []
                    if net_bucket:
                        api_items = _items_from_network_bucket(net_bucket)

                    # 对 undone API 尝试分页获取全部条目
                    for row in net_bucket:
                        url = row.get("url", "")
                        if "/site/student/undone" not in url:
                            continue
                        data = row.get("data", {})
                        inner = (data.get("data") if isinstance(data, dict) else None) or {}
                        undone_list = inner.get("undoneList", [])
                        undone_num = inner.get("undoneNum", 0)
                        if undone_num > len(undone_list):
                            print(
                                f"[分页] undone API 返回 {len(undone_list)}/{undone_num} 条，尝试分页获取剩余条目...",
                                flush=True,
                            )
                            all_api_items = _paginate_api(
                                page, url,
                                list_key="undoneList",
                                total_key="undoneNum",
                                page_size=100,
                            )
                            if len(all_api_items) > len(undone_list):
                                print(
                                    f"[分页] 分页获取到 {len(all_api_items)} 条 undone 条目",
                                    flush=True,
                                )
                                # 将分页数据注入回 net_bucket 以便统一提取
                                from copy import deepcopy
                                enriched = deepcopy(row)
                                enriched["data"] = {
                                    "code": 200,
                                    "data": {
                                        "undoneNum": undone_num,
                                        "undoneList": all_api_items,
                                    },
                                }
                                api_items = _items_from_network_bucket([enriched] + net_bucket)
                            else:
                                print(
                                    "[分页] 分页无更多数据（API 可能按类型分桶，"
                                    "undoneNum 为跨类型合计）",
                                    flush=True,
                                )
                        break

                    api_items = _filter_junk_items(api_items)

                    # ---- 全量 per-course API 抓取（含已提交作业） ----
                    extra_items: list[HomeworkItem] = []
                    try:
                        courses, uid = _get_courses(page, net_bucket)
                        if courses:
                            saved_courses = courses
                            undone_ids: set[str] = set()
                            for row in net_bucket:
                                url = row.get("url", "")
                                if "/site/student/undone" in url:
                                    data = row.get("data", {})
                                    inner = (data.get("data") if isinstance(data, dict) else None) or {}
                                    for u in inner.get("undoneList", []):
                                        aid = str(u.get("activityId", ""))
                                        if aid:
                                            undone_ids.add(aid)
                            # fallback: 用 context.request 直接调 undone API
                            if not undone_ids:
                                try:
                                    ic_token = ""
                                    for c in context.cookies():
                                        if c.get("name") == "iClass-token":
                                            ic_token = c.get("value", "")
                                            break
                                    headers = {"Blade-Auth": ic_token} if ic_token else {}
                                    uresp = context.request.get(
                                        "https://apiucloud.bupt.edu.cn/ykt-site/site/student/undone",
                                        params={"userId": uid},
                                        headers=headers,
                                    )
                                    if uresp.status == 200:
                                        ud = uresp.json()
                                        ul = (ud.get("data") if isinstance(ud, dict) else None) or {}
                                        for u in ul.get("undoneList", []):
                                            aid = str(u.get("activityId", ""))
                                            if aid:
                                                undone_ids.add(aid)
                                        info(f"[全量作业] undone API 直接调用获取到 {len(undone_ids)} 个 undone ID")
                                except Exception:
                                    pass

                            if mode in ("all", "homework"):
                              work_records = _fetch_all_course_work_items(page, context, courses, uid)
                            else:
                              work_records = []
                            if work_records:
                                # 获取 token 用于调用详情 API
                                detail_token = ""
                                try:
                                    for c in context.cookies():
                                        if c.get("name") == "iClass-token":
                                            detail_token = c.get("value", "")
                                            break
                                except Exception:
                                    pass
                                if detail_token:
                                    _enrich_work_records_with_details(
                                        context, work_records, detail_token
                                    )
                                    _download_attachments(context, work_records, detail_token)
                                extra_items = _convert_work_records_to_items(work_records, undone_ids)
                                if extra_items:
                                    print(
                                        f"[全量作业] per-course 获取到 {len(extra_items)} 条作业",
                                        flush=True,
                                    )
                    except Exception as e:
                        warn(f"[全量作业] per-course 抓取失败: {e}")

                    # ---- 课程级资源（课程本身上传的文件） ----
                    if mode in ("all", "courses"):
                      try:
                          cr_token = ""
                          for c in context.cookies():
                              if c.get("name") == "iClass-token":
                                  cr_token = c.get("value", "")
                                  break
                          if cr_token and saved_courses:
                              cr = _fetch_course_resources(page, context, saved_courses, cr_token)
                              if cr:
                                  course_resources = cr
                      except Exception as e:
                          warn(f"[课程资源] 获取失败: {e}")

                    # ---- 合并 & 去重 ----
                    merged = dom_items + api_items + extra_items
                    items = _dedupe_homework_items(merged)
                    if items:
                        print(
                            f"[合并] DOM {len(dom_items)} + undone API {len(api_items)}"
                            f" + per-course {len(extra_items)} → 去重后 {len(items)} 条",
                            flush=True,
                        )
                    else:
                        items = dom_items if dom_items else (api_items if api_items else extra_items)

                    if not items and cfg.get("debug_dump_on_empty", True):
                        try:
                            (DATA_DIR / "debug_page_empty.html").write_text(
                                page.content(), encoding="utf-8"
                            )
                        except Exception:
                            pass
                    if items:
                        break

                # 所有 URL 遍历完仍未找到数据，写入诊断摘要
                if not items and debug_dump:
                    summary = {
                        "error": "未找到课业数据",
                        "login_state": login_state,
                        "urls_tried": list(tried_hashes),
                        "nav_errors": nav_errors,
                        "total_api_requests": len(net_bucket),
                        "total_all_requests": len(debug_all_bucket),
                        "suggestion": (
                            "可能原因：1) 登录态已过期，请重新登录；"
                            "2) 课业数据在未尝试的页面路由；"
                            "3) API 端点不在捕获范围内。"
                            "请查看 debug_network.json 中 all_requests 字段，"
                            "找到含课业数据的请求 URL 并更新 config.yaml 的 target_url 和 network_capture_url_substrings。"
                        ),
                    }
                    (DATA_DIR / "debug_network.json").write_text(
                        json.dumps(summary, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                    print(f"[诊断] {summary['suggestion']}", flush=True)

                # 在所有 URL 遍历完后提取课程数（优先用已获取的课程列表长度）
                course_count = len(saved_courses) if saved_courses else _get_course_count(page, net_bucket)

            finally:
                context.close()
                if browser is not None:
                    browser.close()
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"抓取过程出错: {e}") from e

    if not items and nav_errors and len(nav_errors) >= len(urls_to_try):
        raise RuntimeError(
            "所有目标地址均无法打开（请检查网络、登录态与 URL）: " + " | ".join(nav_errors[:5])
        )

    if max_items is not None and len(items) > max_items:
        items = items[:max_items]

    return items, course_count, saved_courses, course_resources


def save_cache(
    items: list[HomeworkItem],
    *,
    portal_url: str = "",
    warning: str | None = None,
    updated: str = "",
) -> None:
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    payload: dict[str, Any] = {
        "schema_version": CACHE_SCHEMA_VERSION,
        "portal_url": portal_url,
        "updated_at": updated or now,
        "items": [asdict(x) if not isinstance(x, dict) else x for x in items],
    }
    if warning:
        payload["_warning"] = warning
    CACHE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def save_course_cache(
    courses: list[dict[str, Any]],
    course_count: int = 0,
    course_resources: dict[str, list[dict[str, Any]]] | None = None,
    updated: str = "",
) -> None:
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    payload: dict[str, Any] = {
        "schema_version": CACHE_SCHEMA_VERSION,
        "updated_at": updated or now,
        "course_count": course_count,
        "courses": [
            {
                "id": c.get("id", ""),
                "siteName": c.get("siteName", ""),
                "mainSiteName": c.get("mainSiteName", ""),
                "courseTeacher": c.get("courseTeacher", "") or c.get("teacherName", "") or "",
                "siteType": c.get("siteType", ""),
            }
            for c in (courses or [])
        ],
        "courseResources": course_resources or {},
    }
    COURSE_CACHE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def load_course_cache() -> dict[str, Any]:
    if not COURSE_CACHE_PATH.is_file():
        return {"updated_at": "", "courses": [], "course_count": 0, "courseResources": {}}
    return json.loads(COURSE_CACHE_PATH.read_text(encoding="utf-8"))


def load_cache() -> dict[str, Any]:
    if not CACHE_PATH.is_file():
        return {"updated_at": "", "items": []}
    return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
