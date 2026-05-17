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


