# 北邮作业待办 · BUPT UCloud Desktop

> 免登录、自动同步、桌面待办。为 BUPT UCloud 教学云平台打造的 Electron 桌面客户端。

[![Version](https://img.shields.io/badge/version-0.9.0-blue)](#)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey)](#)
[![License](https://img.shields.io/badge/license-MIT-green)](#)

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

## 架构

```
┌─ Electron 前端 ───────────────────────────────┐
│  main.js    窗口/Tray/IPC/调度                  │
│  preload.js contextBridge (~30 API)            │
│  app/       4 Tab SPA (首页|待办|课程|设置)     │
│  onboarding 首次配置向导                        │
│  login/     自动登录 + webview 手动登录          │
├─ Python 后端 ─────────────────────────────────┤
│  homework_fetcher.py  核心抓取引擎              │
│    ├─ DOM 提取 (6 种策略)                       │
│    ├─ API 提取 (XHR 拦截 + 分页)                │
│    └─ 逐课程全量抓取 (POST /ykt-site/work/...)   │
│  auto_login.py   CAS SSO 自动登录               │
│  extraction.py   提取策略套件                    │
├─ 数据 ────────────────────────────────────────┤
│  homework_cache.json  作业缓存                  │
│  course_cache.json    课程+资源缓存              │
│  playwright_storage_state.json  登录态          │
│  config.yaml          用户配置+加密凭据          │
├─ 打包 ────────────────────────────────────────┤
│  PyInstaller → bupt-hw.exe (Python+依赖)        │
│  python-dist/playwright-browsers/ (Chromium)    │
│  electron-builder NSIS → 安装包 Setup.exe       │
└──────────────────────────────────────────────┘
```

## 安装（用户）

从 [Releases](../../releases) 下载 `北邮作业待办 Setup x64.exe`，双击安装。

安装包自包含所有依赖：Python 运行时、Playwright、Chromium 浏览器。**用户无需额外安装任何东西。**

首次启动自动进入配置向导：输入学号密码 → 选择同步频率 → 完成。

## 开发

### 环境

- Windows 10/11
- Python 3.10+（安装 `pip install -r requirements.txt`）
- Node.js 18+
- Playwright Chromium（`python -m playwright install chromium`）

### 启动

```powershell
npm install
npm start          # Electron 开发模式
```

### Python CLI

```powershell
python python/app.py fetch              # 抓取全部
python python/app.py sync-homework      # 仅作业
python python/app.py sync-courses       # 仅课程
python python/app.py check              # 环境检查
python python/app.py set-credentials    # 保存凭据
```

### 构建安装包

```bat
build-installer.bat
```

或手动：

```powershell
# 1. PyInstaller
python -m PyInstaller --onedir --name bupt-hw `
  --add-data "python/config.example.yaml;." `
  --hidden-import playwright --hidden-import yaml --hidden-import cryptography `
  python/app.py

# 2. 准备 python-dist
cp -r dist/bupt-hw python-dist/bupt-hw
cp -r $env:USERPROFILE\AppData\Local\ms-playwright\chromium-1217 python-dist\playwright-browsers\

# 3. electron-builder
npm run dist
```

输出在 `release/` 目录。

## 目录结构

```
BUPT-UCloud-Desktop/
├── electron/           # 前端代码
│   ├── main.js         # 主进程（IPC/窗口/Tray）
│   ├── preload.js      # 桥接层
│   └── app/            # 渲染进程（4 Tab）
├── python/             # 后端代码
│   ├── app.py          # CLI 入口
│   ├── homework_fetcher.py  # 核心抓取
│   ├── auto_login.py   # CAS 自动登录
│   ├── extraction.py   # 提取策略
│   └── fetchers/       # 子模块
├── python-dist/        # [构建产物] 自包含后端
├── release/            # [构建产物] 安装包
└── build-installer.bat # 一键构建脚本
```

## 关联项目

| 项目 | 说明 |
|------|------|
| [BUPT_UCloud_Widget](https://github.com/xuzhunzhi/BUPT_UCloud_Widget) | 原始项目（含 Widget 小组件 + WPF 桌面组件） |
| 本仓库 | 从 Widget fork，移除小组件代码，独立打包 |

## 合规

仅供个人查看本人课业；勿高频请求；勿泄露 `browser_profile` 和凭据。

## 联系

- Issue: [GitHub Issues](../../issues)
- Email: xuzhunzhi@foxmail.com

---

*本项目所有代码由 Claude Code 辅助生成。*
