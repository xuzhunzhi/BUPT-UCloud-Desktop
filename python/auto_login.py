"""
CAS 自动登录模块：检测登录页面、填写账号密码、提交并验证。
由 homework_fetcher.fetch_homework() 在检测到未登录时调用。
"""
from __future__ import annotations

import re
from typing import Any

from playwright.sync_api import Frame, Page

from exceptions import ConfigError, LoginError
from logger import info, warn, error


def _is_cas_login_page(page: Page) -> bool:
    """检测当前页面是否需要登录（不依赖可见性，只查 DOM）。"""
    url = page.url.lower()
    if ("cas" in url or "authserver" in url) and ("login" in url or "auth" in url):
        return True
    if "login" in url and ("passport" in url or "sso" in url or "auth" in url):
        return True
    return False


def _get_login_frame(page: Page) -> Frame | None:
    """获取 CAS 登录页面的 iframe（#loginIframe）。"""
    try:
        frame = page.frame(name="loginIframe") or page.frame(url=re.compile(r"login-normal"))
        if frame:
            return frame
    except Exception:
        pass
    # fallback: 遍历所有 frame
    for f in page.frames:
        if "login-normal" in f.url or f.name == "loginIframe":
            return f
    return None


def _fill_and_submit_in_frame(frame: Frame, username: str, password: str) -> str:
    """在 iframe 内用 JS 填写凭据并提交（绕过 headless 下的可见性检查）。"""
    result = frame.evaluate(
        """([u, p]) => {
            // Step 1: 切换到「账号登录」tab（默认是扫码登录）
            const tabs = document.querySelectorAll('.content-title a, [class*="content-title"] a, a');
            let pwTab = null;
            for (const a of tabs) {
                if (a.textContent.includes('账号登录') || a.textContent.includes('密码登录') || a.textContent.includes('帳號登錄')) {
                    pwTab = a;
                    break;
                }
            }
            if (pwTab) {
                pwTab.click();
            }

            // Wait a bit synchronously is not possible, but the click should queue

            // Step 2: 查找用户名和密码输入框（优先 id，其次 name）
            let userEl = document.getElementById('username');
            let passEl = document.getElementById('password');
            // fallback: try name attribute
            if (!userEl) userEl = document.querySelector("input[name='username']");
            if (!passEl) passEl = document.querySelector("input[name='password']");

            if (!userEl || !passEl) return 'no_inputs';

            // Step 3: 用原生 setter 填写（绕过框架的可见性检查）
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
            );
            if (nativeSetter && nativeSetter.set) {
                nativeSetter.set.call(userEl, u);
                nativeSetter.set.call(passEl, p);
            } else {
                userEl.value = u;
                passEl.value = p;
            }

            userEl.dispatchEvent(new Event('input', {bubbles: true}));
            userEl.dispatchEvent(new Event('change', {bubbles: true}));
            passEl.dispatchEvent(new Event('input', {bubbles: true}));
            passEl.dispatchEvent(new Event('change', {bubbles: true}));

            // Step 4: 检查验证码
            const cpt = document.getElementById('cptValue');
            if (cpt) {
                const style = window.getComputedStyle(cpt);
                const rect = cpt.getBoundingClientRect();
                let parent = cpt.parentElement;
                let hidden = false;
                while (parent) {
                    const s = window.getComputedStyle(parent);
                    if (s.display === 'none' || s.visibility === 'hidden') {
                        hidden = true;
                        break;
                    }
                    parent = parent.parentElement;
                }
                if (!hidden && rect.width > 0 && rect.height > 0) {
                    return 'captcha_required';
                }
            }

            // Step 5: 点击登录按钮
            // iframe 内是 type=button 且调用 loginPassword()
            let submitBtn = document.querySelector('.submit-btn');
            if (!submitBtn) {
                const btns = document.querySelectorAll('input[type="button"]');
                for (const b of btns) {
                    if (b.value.includes('登录') || b.value.includes('登錄') || b.value.includes('Login')) {
                        submitBtn = b;
                        break;
                    }
                }
            }
            if (submitBtn) {
                submitBtn.click();
                return 'clicked';
            }

            // fallback: 调用 loginPassword()
            if (typeof loginPassword === 'function') {
                loginPassword();
                return 'clicked_fn';
            }

            return 'no_submit';
        }""",
        [username, password],
    )
    return result


def perform_auto_login(page: Page, cfg: dict[str, Any]) -> bool:
    """在给定 page 上执行自动登录。成功返回 True，失败返回 False。"""
    username = str(cfg.get("username") or "").strip()
    password = str(cfg.get("password") or "").strip()

    if not username or not password:
        raise ConfigError("未配置 username/password，请在 config.yaml 中填写或设置环境变量 BUPT_USERNAME / BUPT_PASSWORD")

    # 清除所有 cookie，避免过期 storage_state 干扰登录流程
    try:
        page.context.clear_cookies()
        info("[自动登录] 已清除过期 cookies")
    except Exception as e:
        error(f"[自动登录] 清除 cookies 失败: {e}")

    if not _is_cas_login_page(page):
        info("[自动登录] 当前不在 CAS 登录页，尝试导航触发重定向...")
        login_url = str(cfg.get("login_start_url") or cfg.get("target_url") or "")
        if not login_url:
            raise ConfigError("未配置 login_start_url，无法触发 CAS 重定向")
        try:
            page.goto(login_url, wait_until="networkidle", timeout=60_000)
            page.wait_for_timeout(5000)
            info(f"[自动登录] 导航后当前 URL: {page.url[:120]}")
            try:
                page.wait_for_url(
                    lambda u: "cas" in u.lower() or "auth" in u.lower(),
                    timeout=20_000,
                )
            except Exception:
                info("[自动登录] 未检测到 CAS 跳转，尝试在当前页查找登录表单")
        except Exception as e:
            raise LoginError(f"导航到登录页失败: {e}") from e

        if not _is_cas_login_page(page):
            pw_count = page.locator("input[type='password']").count()
            if pw_count == 0:
                raise LoginError("当前页面无可用的登录表单，可能已登录或网络异常")
            info(f"[自动登录] 当前页面密码输入框数量: {pw_count}")

    info("[自动登录] 检测到登录页面，尝试填写凭据...")

    # 等待页面就绪
    page.wait_for_timeout(2000)

    # 优先使用 iframe 内的登录表单
    frame = _get_login_frame(page)
    if frame:
        info("[自动登录] 在 iframe 内填写凭据")
        result = _fill_and_submit_in_frame(frame, username, password)
    else:
        # Fallback: 主页面内的表单
        info("[自动登录] 在主页面内填写凭据")
        try:
            page.fill("input[name='username']", username)
            page.fill("input[name='password']", password)
            page.click("input[name='submit'], button[type='submit'], .btn-login")
            result = "clicked"
        except Exception as e:
            raise LoginError(f"主页面填写失败: {e}") from e

    info(f"[自动登录] 填写结果: {result}")

    if result == "no_inputs":
        raise LoginError("CAS 登录表单结构已变更，无法找到用户名/密码输入框")
    if result in ("fill_error", "click_error"):
        raise LoginError(f"登录表单填写失败: {result}")
    if result == "no_submit":
        raise LoginError("无法找到登录提交按钮，表单结构可能已变更")

    if result == "captcha_required":
        raise LoginError("需要人工输入验证码，请通过应用内登录页面登录")

    info("[自动登录] 已提交登录，等待页面跳转...")

    # 等待页面跳转回 ucloud
    try:
        page.wait_for_url(
            re.compile(r"ucloud\.bupt\.edu\.cn"),
            timeout=30_000,
        )
        info("[自动登录] 已跳转回 ucloud")
    except Exception:
        cur = page.url.lower()
        if "ucloud.bupt.edu.cn" in cur:
            info("[自动登录] 已在 ucloud 域名")
        else:
            raise LoginError(f"登录后未能跳转回 ucloud，当前: {page.url[:120]}")

    page.wait_for_timeout(3000)

    if _is_cas_login_page(page):
        raise LoginError("登录失败：仍在 CAS 登录页面，请检查账号密码是否正确")

    # 登录成功后将 session 保存为 storage_state
    try:
        from pathlib import Path
        from homework_fetcher import STORAGE_STATE_PATH
        STORAGE_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        page.context.storage_state(path=str(STORAGE_STATE_PATH))
        info("[自动登录] 已保存登录会话")
    except Exception as e:
        error(f"[自动登录] 保存会话失败: {e}")

    if "ucloud.bupt.edu.cn" in page.url.lower():
        info("[自动登录] 登录成功！")
        return True

    raise LoginError(f"登录后 URL 异常: {page.url[:120]}")
