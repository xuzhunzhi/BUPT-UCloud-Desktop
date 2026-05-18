"""
从北邮云邮教学空间学生端抓取作业列表（需已登录）。
页面为 SPA，使用 Playwright 持久化 profile 保存登录态。
"""
from __future__ import annotations

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
EXAMPLE_CONFIG = SCRIPT_DIR / "config.example.yaml"
# 由 Electron 内登录页导出，供 Playwright 复用 cookies（避免单独开 Chromium 登录）
STORAGE_STATE_PATH = DATA_DIR / "playwright_storage_state.json"




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
    api_base = "https://apiucloud.bupt.edu.cn"
    for row in net_bucket:
        url = row.get("url", "")
        m = re.match(r"(https?://[^/]+)", url)
        if m and ("api" in url.lower() or "ucloud" in url.lower()):
            api_base = m.group(1)
            break

    user_id = page.evaluate(
        """() => {
        try {
            const store = JSON.parse(localStorage.getItem('store') || '{}');
            return store.user_id || store.userId || null;
        } catch(e) { return null; }
    }"""
    )
    if not user_id:
        warn("[课程计数] 无法获取 userId")
        return 0

    result = _fetch_api_from_page(
        page,
        f"{api_base}/ykt-site/site/list/student/current"
        f"?userId={user_id}&siteRoleCode=2&size=999&current=1",
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
    # Step 1: 从 net_bucket 提取 userId
    user_id = page.evaluate(
        """() => {
        try {
            const store = JSON.parse(localStorage.getItem('store') || '{}');
            return store.user_id || store.userId || null;
        } catch(e) { return null; }
    }"""
    )
    if not user_id:
        for row in net_bucket:
            m = re.search(r"userId=(\d+)", row.get("url", ""))
            if m:
                user_id = m.group(1)
                break
    if not user_id:
        warn("[全量作业] 无法获取 userId")
        return [], ""

    # Step 2: 从 net_bucket 提取课程列表
    for row in net_bucket:
        url = row.get("url", "")
        if "/site/list/student/current" in url:
            data = row.get("data", {})
            inner = (data.get("data") if isinstance(data, dict) else None) or {}
            records = inner.get("records", [])
            if records:
                info(f"[全量作业] 从网络捕获获取到 {len(records)} 门课程")
                return records, user_id

    # Step 3: Fallback 直接调 API
    api_base = "https://apiucloud.bupt.edu.cn"
    result = _fetch_api_from_page(
        page,
        f"{api_base}/ykt-site/site/list/student/current"
        f"?userId={user_id}&siteRoleCode=2&size=999&current=1",
    )
    if result and isinstance(result, dict) and result.get("code") == 200:
        records = result.get("data", {}).get("records", [])
        if records:
            info(f"[全量作业] 从 API 获取到 {len(records)} 门课程")
            return records, user_id

    warn("[全量作业] 未能获取课程列表")
    return [], user_id



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
            "attachmentId": res.get("id", ""),
            "rawResourceId": res.get("resourceId", ""),
            "fileUrl": r.get("fileUrl") or r.get("url") or res.get("fileUrl") or res.get("url") or "",
        })
    return normalized



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


