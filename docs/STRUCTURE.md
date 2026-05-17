# 目录结构

```
bupt-uclass-homework-widget/          # 仓库根（数据默认也在这里：config、缓存、browser_profile）
├── package.json                      # Electron + electron-builder
├── requirements.txt                 # 引用 python/requirements.txt
├── bupt-hw.cmd                      # 快捷调用：bupt-hw login | fetch | widget
├── 首次登录.bat
├── 启动应用.bat
├── 安装Playwright浏览器.bat
├── .npmrc
├── electron/
│   ├── main.js                      # 主进程：窗口、登录、首启、Python 抓取、预警
│   ├── preload.js                   # 各页共用 IPC
│   ├── login-shell.html             # 内嵌网页登录
│   ├── login-shell.js
│   ├── login-preload.js
│   ├── onboarding/                  # 首次运行向导（未保留 prefs 时）
│   │   ├── index.html
│   │   ├── onboarding.css
│   │   └── onboarding.js
│   ├── home/                        # 客户端主页
│   │   ├── index.html
│   │   ├── home.css
│   │   └── home.js
│   ├── settings/                    # 设置
│   └── widget/                      # 置顶桌面小组件
│       ├── index.html
│       ├── widget.css
│       └── widget.js
├── python/                          # 抓取逻辑（随 exe 打进 resources）
│   ├── app.py
│   ├── paths.py                    # 数据目录：BUPT_DATA_DIR 或 仓库根
│   ├── homework_fetcher.py
│   ├── widget.py
│   ├── config.example.yaml
│   └── requirements.txt
├── tools/
│   └── tee-login.ps1
├── docs/
│   ├── STRUCTURE.md                 # 本文件
│   └── 项目说明.md
├── .venv/                           # 本机 Python 虚拟环境（不随打包分发）
├── browser_profile/                 # Playwright 登录态（gitignore）
├── config.yaml                      # 用户配置（可 gitignore）
└── homework_cache.json              # 上次抓取结果
```

**打包后**（`npm run dist`）：`release/` 下生成安装包与 `portable` 免安装目录；配置与缓存改到 `%APPDATA%\北邮作业待办`（由 `BUPT_DATA_DIR` 指定）。
