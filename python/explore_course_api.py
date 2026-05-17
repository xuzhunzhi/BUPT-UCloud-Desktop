"""使用 Playwright APIRequestContext 直接调用 per-course API 建立映射。"""
import json, sys, time, io
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

DATA_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from homework_fetcher import (
    load_config, _resolve_user_data, _use_playwright_storage_state,
    _post_goto_networkidle, STORAGE_STATE_PATH,
)

API_BASE = "https://apiucloud.bupt.edu.cn"
cfg = load_config()
headless = "--no-headless" not in sys.argv
user_data = _resolve_user_data(cfg)
user_data.mkdir(parents=True, exist_ok=True)
use_st = _use_playwright_storage_state(cfg)

with sync_playwright() as p:
    if use_st:
        browser = p.chromium.launch(headless=headless, args=["--disable-blink-features=AutomationControlled"])
        context = browser.new_context(storage_state=str(STORAGE_STATE_PATH), locale="zh-CN", viewport={"width": 1400, "height": 900})
    else:
        context = p.chromium.launch_persistent_context(user_data_dir=str(user_data), headless=headless, locale="zh-CN", viewport={"width": 1400, "height": 900}, args=["--disable-blink-features=AutomationControlled"])

    try:
        page = context.pages[0] if context.pages else context.new_page()
        nav_timeout = 120_000

        # Step 1: 导航首页获取登录态和课程列表
        print("[1] 获取登录态...")
        page.goto("https://ucloud.bupt.edu.cn/uclass/index.html#/student/homePage",
                  wait_until="networkidle", timeout=nav_timeout)
        _post_goto_networkidle(page, cfg)
        page.wait_for_timeout(8000)

        h = page.evaluate("() => window.location.hash") or ""
        if h in ("#/", "#", ""):
            page.goto("https://ucloud.bupt.edu.cn/uclass/index.html#/student/homePage",
                      wait_until="networkidle", timeout=nav_timeout)
            _post_goto_networkidle(page, cfg)
            page.wait_for_timeout(8000)

        # 获取 token 和 userId
        token = None
        user_id = None
        # 从 page.evaluate 获取 token
        token = page.evaluate("""() => {
            const cookies = document.cookie.split(';');
            for (const c of cookies) {
                const [k, v] = c.trim().split('=');
                if (k === 'Blade-Auth') return v;
            }
            return null;
        }""")

        # 或从 localStorage 获取
        if not token:
            token = page.evaluate("() => localStorage.getItem('token') || localStorage.getItem('access_token')")
        if not token:
            token = page.evaluate("() => sessionStorage.getItem('token') || sessionStorage.getItem('access_token')")

        # 从页面获取 userId
        user_id = page.evaluate("""() => {
            try {
                const store = JSON.parse(localStorage.getItem('store') || '{}');
                return store.user_id || store.userId || null;
            } catch(e) { return null; }
        }""")
        if not user_id:
            user_id = page.evaluate("""() => {
                try {
                    const state = JSON.parse(localStorage.getItem('vuex') || '{}');
                    return state.user?.user_id || state.user?.userId || null;
                } catch(e) { return null; }
            }""")

        print(f"  token: {'有' if token else '无'}")
        print(f"  userId: {user_id}")

        # Step 2: 用 APIRequestContext 直接获取
        print("\n[2] 直接调用 API...")
        api = context.request

        # 获取课程列表
        courses_resp = api.get(
            f"{API_BASE}/ykt-site/site/list/student/current",
            params={"userId": user_id, "siteRoleCode": "2", "size": "999", "current": "1"}
        )
        courses_data = courses_resp.json()
        courses = courses_data.get("data", {}).get("records", [])
        site_num = len(courses)
        print(f"  课程数: {site_num}")

        # 获取 undone 列表
        undone_resp = api.get(
            f"{API_BASE}/ykt-site/site/student/undone",
            params={"userId": user_id}
        )
        undone_data = undone_resp.json()
        undone_inner = undone_data.get("data", {})
        undone_list = undone_inner.get("undoneList", [])
        undone_num = undone_inner.get("undoneNum", 0)
        print(f"  undone: {undone_num} 条")

        # 打印 undone 条目示例
        if undone_list:
            print(f"\n  undone item 示例:")
            print(f"  {json.dumps(undone_list[0], ensure_ascii=False, indent=2)}")
            print(f"  {json.dumps(undone_list[1], ensure_ascii=False, indent=2)}")

        # Step 3: 对每门课程获取作业列表，建立 activityId→course 映射
        print(f"\n[3] 逐课程获取作业列表...")
        activity_to_course = {}  # activityId -> {siteId, siteName}
        course_undone_counts = {}  # siteId -> undone count

        for idx, course in enumerate(courses):
            site_id = course["id"]
            site_name = course["siteName"]
            print(f"  [{idx+1}/{site_num}] {site_name} ...", end=" ", flush=True)

            resp = api.post(
                f"{API_BASE}/ykt-site/work/student/list",
                params={
                    "siteId": site_id,
                    "userId": user_id,
                    "current": "1",
                    "size": "200",  # 取足够多
                }
            )
            data = resp.json()
            records = data.get("data", {}).get("records", [])
            total = data.get("data", {}).get("total", 0)
            print(f"{len(records)}/{total} assignments")

            # Dump full record schema for the first course
            if idx == 0 and records:
                print(f"\n  === FULL RECORD SCHEMA (first 2 items) ===")
                for ri, rec in enumerate(records[:2]):
                    print(f"  --- Record {ri+1} ---")
                    for k, v in sorted(rec.items(), key=lambda x: str(x[0])):
                        vt = type(v).__name__
                        vp = str(v)[:300]
                        print(f"    {k}: {vt} = {vp}")
                print(f"  === END SCHEMA ===\n")

            for rec in records:
                aid = str(rec.get("id", ""))
                if aid:
                    activity_to_course[aid] = {"siteId": site_id, "siteName": site_name}

        print(f"\n  映射表大小: {len(activity_to_course)}")

        # Step 4: 尝试匹配 undone items
        print(f"\n[4] 匹配 undone items...")
        matched = 0
        unmatched = 0
        for item in undone_list:
            aid = str(item.get("activityId", ""))
            if aid in activity_to_course:
                matched += 1
                c = activity_to_course[aid]
                cid = c["siteId"]
                course_undone_counts[cid] = course_undone_counts.get(cid, 0) + 1
            else:
                unmatched += 1
                if unmatched <= 3:
                    print(f"  未匹配: activityId={aid} name={item.get('activityName', '')[:50]}")

        print(f"\n  匹配成功: {matched}, 未匹配: {unmatched}")

        # 输出课程列表及未完成计数
        print(f"\n[5] 课程待办统计:")
        print(f"{'课程名':<30} {'待办数':>6}")
        print("-" * 38)
        for course in courses:
            cid = course["id"]
            count = course_undone_counts.get(cid, 0)
            marker = " *" if count > 0 else ""
            print(f"{course['siteName']:<30} {count:>5}{marker}")

        # 保存结果
        result = {
            "siteNum": site_num,
            "undoneNum": undone_num,
            "activity_mapping_size": len(activity_to_course),
            "matched": matched,
            "unmatched": unmatched,
            "course_undone_counts": {
                c["siteName"]: {"siteId": c["id"], "undoneCount": course_undone_counts.get(c["id"], 0)}
                for c in courses
            },
        }
        out = DATA_DIR / "course_mapping_result.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"\n已保存: {out}")

    finally:
        context.close()
        if use_st:
            browser.close()
