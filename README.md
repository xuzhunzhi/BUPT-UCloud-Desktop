# 北邮作业待办 · BUPT UCloud Desktop

[![Version](https://img.shields.io/badge/version-0.9.1-blue)](#)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey)](#)
[![License](https://img.shields.io/badge/license-MIT-green)](#)

## 简述

本项目为本人为免于每天多次登录 BUPT UCloud 教学云平台所写的爬取小程序，使用 Python 完成爬取，前端采用 Electron 框架以便多端部署，目前已基本完成本人需求。

程序没有服务器，后端全部在本地运行，通过 Playwright 浏览器完成与教学云平台的连接。

由于本人缺乏 Python 与 JS 的相关知识（实则目前只会基本的 C），所以项目所有代码由 Vibe Coding 完成，因此本人无法确保项目代码的健壮性，望诸位谅解，如有好的建议与意见欢迎在 Issue 中提出，也可以直接通过 xuzhunzhi@foxmail.com 联系本人。

## 功能

- **自动同步** — 学号密码一次配置，Playwright 模拟浏览器自动登录 CAS，定时抓取作业
- **卡片式待办** — 颜色标记紧急程度（逾期/紧急/即将截止/正常/已提交）
- **课程管理** — 课程列表、课程文件浏览与下载、教师信息
- **作业提交** — 直接在应用内提交文本 + 附件
- **系统托盘** — 关闭即最小化到托盘，后台定时刷新
- **预警通知** — 多级冷却时间，截止前弹窗提醒
- **自包含安装包** — 用户无需安装 Python、Node.js、浏览器内核

## 技术栈

```
桌面壳    Electron 33 + 原生 JS（无框架 SPA）
浏览器    Playwright (Chromium, headless)
抓取      Python 3.10+（Playwright sync API）
加密      cryptography (Fernet)
打包      PyInstaller → electron-builder (NSIS)
```

## 环境

- Windows 10/11
- Python 3.10+
- Node.js 18+
- Playwright Chromium

## 安装（开发）

```powershell
cd BUPT-UCloud-Desktop
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m playwright install chromium
npm install
```

若无 `config.yaml`：复制 `python\config.example.yaml` 到根目录并改名为 `config.yaml`。

## 使用

| 操作 | 命令 |
|------|------|
| Electron 界面 | `npm start` |
| 抓取全部 | `python python\app.py fetch` |
| 仅抓作业 | `python python\app.py sync-homework` |
| 仅抓课程 | `python python\app.py sync-courses` |
| 抓取（调试） | `python python\app.py fetch --debug` |
| 环境检查 | `python python\app.py check` |
| 保存凭据 | `python python\app.py set-credentials` |

抓取的缓存与配置默认在**仓库根目录**（与 `python/` 并列）；打包成 exe 后数据在用户目录 `AppData`。

## 打包安装包

一键构建（需要本机已安装 Python 和 Playwright 浏览器）：

```bat
build-installer.bat
```

或手动：

```powershell
# 1. PyInstaller 打包 Python 后端
python -m PyInstaller --onedir --name bupt-hw `
  --add-data "python/config.example.yaml;." `
  --hidden-import playwright --hidden-import yaml --hidden-import cryptography `
  python/app.py

# 2. 准备自包含目录
cp -r dist/bupt-hw python-dist/bupt-hw
cp -r $env:USERPROFILE\AppData\Local\ms-playwright\chromium-1217 python-dist\playwright-browsers\
cp -r $env:USERPROFILE\AppData\Local\ms-playwright\chromium_headless_shell-1217 python-dist\playwright-browsers\
cp -r $env:USERPROFILE\AppData\Local\ms-playwright\ffmpeg-1011 python-dist\playwright-browsers\
cp -r $env:USERPROFILE\AppData\Local\ms-playwright\winldd-1007 python-dist\playwright-browsers\

# 3. electron-builder 打包安装包
npm run dist
```

输出在 **`release/`**（NSIS 安装包，约 323MB）。安装包自包含 Python 运行时 + Playwright + Chromium 浏览器，用户安装后无需额外配置即可使用。

## 合规

仅供个人查看本人课业；勿高频请求；勿泄露 `browser_profile` 和凭据。

## 故障排除

| 现象 | 处理 |
|------|------|
| `Executable doesn't exist ... chrome.exe` | `python -m playwright install chromium` |
| 列表不准 | `python python\app.py fetch --debug`，按 `debug_page.html` 配置 `homework_item_selector` |
| npm 慢 | `npm config set registry https://registry.npmmirror.com` |
| 加密密钥丢失 | 删除 `.encryption_key`，重新运行 `set-credentials` |

---

*本项目所有代码由 Claude Code 辅助生成。*
