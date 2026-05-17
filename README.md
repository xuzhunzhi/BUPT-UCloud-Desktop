# 北邮云邮教学空间 · 作业待办

中文说明见 **[docs/项目说明.md](docs/项目说明.md)**，目录结构见 **[docs/STRUCTURE.md](docs/STRUCTURE.md)**。

## 环境

- Python 3.10+、Node.js 18+、Windows 10/11。

## 安装（在仓库根目录）

```powershell
cd %USERPROFILE%\bupt-uclass-homework-widget
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m playwright install chromium
npm install
```

若无 `config.yaml`：复制 `python\config.example.yaml` 到根目录并改名为 `config.yaml`。

## 使用

| 操作 | 命令或快捷方式 |
|------|----------------|
| 首次登录 | 双击 **`首次登录.bat`** 或 `bupt-hw.cmd login` |
| 仅抓取 | `bupt-hw.cmd fetch` 或 `python python\app.py fetch` |
| 抓取（调试） | `bupt-hw.cmd fetch --debug` 或 `python python\app.py fetch --debug` |
| 环境检查 | `bupt-hw.cmd check` 或 `python python\app.py check` |
| Electron 界面 | **`启动应用.bat`** 或 `npm start`（默认打开**主页**；「桌面小组件」在主页内打开） |
| tkinter 界面 | `bupt-hw.cmd widget` |

抓取的缓存与配置默认在**仓库根目录**（与 `python/` 并列）；打包成 exe 后数据在用户目录 `AppData`（见项目说明）。

## 打包 exe

```powershell
npm run dist
```

输出在 **`release/`**（NSIS 安装包 + portable `.exe`）。Portable 仍需本机具备 Python 运行时与依赖，或将开发用 `.venv` 置于 exe 旁；详见 `docs/项目说明.md`。

## 合规

仅供个人查看本人课业；勿高频请求；勿泄露 `browser_profile`。

## 故障排除

| 现象 | 处理 |
|------|------|
| `Executable doesn't exist ... chrome.exe` | `python -m playwright install chromium` 或 **`安装Playwright浏览器.bat`** |
| 列表不准 | `python python\app.py fetch --debug`，按 `debug_page.html` 配置 `homework_item_selector` |
| npm 慢 | `npm config set registry https://registry.npmmirror.com` |
