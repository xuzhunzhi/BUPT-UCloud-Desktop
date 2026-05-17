# 交接文档（给下一任对话 / 维护者）

本文档总结 **北邮云邮教学空间 · 作业待办** 小工具（Electron 客户端 + 本机 Python/Playwright 抓取）的当前实现、文件地图与后续注意事项，便于在新会话中快速接续。

---

## 1. 项目做什么

- 在 **Electron** 里提供主页、置顶小组件、内嵌登录窗口；用户登录教学空间后，由 **Python + Playwright** 抓取作业待办列表，写入本地 `**homework_cache.json`**。
- 支持 **定时自动同步**（间隔可配置）、**开机启动**、**启动后自动同步一次**、**系统通知预警**（按距离截止时间分档 + 冷却去重）、**主题**（深色 / 浅色 / 跟随系统）。

---

## 2. 技术栈与入口


| 层级         | 说明                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------- |
| 运行时        | Node + Electron（见根目录 `package.json`，`main` 为 `electron/main.js`）                                  |
| 前端页面       | `electron/home/` 主页、`electron/widget/` 小组件、`electron/settings/` 设置、`electron/login-shell.*` 登录    |
| 共享样式 / 主题  | `electron/shared/themes.css`、`electron/shared/theme-init.js`                                      |
| 截止时间解析（预警） | `electron/lib/due-parse.js`（主进程 `runAlertCheck` 使用）                                               |
| 抓取         | `python/app.py` 等，由主进程 `spawn` 执行；环境变量 `**BUPT_DATA_DIR`** 与 Electron 数据目录对齐（见 `python/paths.py`） |


**常用命令**

- 开发运行：`npm start`（需已 `npm install`；本机需 Python 与 Playwright 环境按项目 README/说明配置）。
- 打包：`npm run dist`（`electron-builder`，输出在 `release/`）。

---

## 3. 目录与职责（速查）

```
electron/
  main.js              # 双窗口管理、IPC、Python 抓取、写 config、预警调度、广播事件
  preload.js           # 暴露 window.buptHw（渲染进程只用这个 API）
  home/                  # 默认入口主页（统计、同步、打开小组件、打开设置）
  widget/                # 置顶小组件（列表 + 定时同步）
  settings/              # 设置页（主题、同步间隔、开机/启动同步、预警档位与冷却）
  shared/                # themes.css、theme-init.js
  lib/due-parse.js         # 从截止文案解析 Date、计算剩余小时数
python/
  app.py, homework_fetcher.py, paths.py, widget.py …
```

---

## 4. 数据文件与路径（很重要）


| 文件                              | 位置 / 说明                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron_prefs.json`           | `**app.getPath('userData')**`（打包后）；开发时通常仍在仓库相关数据目录，与 `main.js` 中 `getDataDir()` 一致。主题、开机、**启动时打开哪些窗口**（`startupOpenMode`）、**首启是否完成**（`onboardingDone`）、启动同步、**预警偏好**存这里。 |
| `config.yaml`                   | 仓库根或资源目录；`**widget_refresh_minutes`** 由设置里的「同步间隔」写入（`setWidgetRefreshMinutesInConfig`）。与 Python `WIDGET_REFRESH_MINUTES_DEFAULT`（默认 **30**）应对齐概念。 |
| `homework_cache.json`           | 抓取结果缓存，供 UI 读取。                                                                                                                                   |
| `playwright_storage_state.json` | 登录会话导出，供 Playwright 使用。                                                                                                                           |
| `alert_notify_state.json`       | 预警 **冷却去重** 状态（按条目 key + 时间戳），已在 `**.gitignore`** 中忽略。                                                                                            |


渲染进程通过 `**window.buptHw**` 调主进程，不要直接 `require('fs')`（`preload` 已做隔离）。

---

## 5. 设置功能对应实现

### 5.1 主题（深色 / 浅色 / 跟随系统）

- 偏好键：`electron_prefs.json` 中的 `**theme**`：`dark` | `light` | `system`。
- `theme-init.js`：`getTheme()` 后设置 `document.documentElement` 的 `**data-theme**`；`system` 时 **移除** `data-theme`，由 `themes.css` 中 `**prefers-color-scheme`** 决定浅色。
- 主进程：`get-theme` / `set-theme` IPC；`nativeTheme.on('updated')` 时 `**broadcastThemeChanged()**`，各窗口收 `**theme-changed**` 后重新 `applyTheme()`。
- Windows：`app.setAppUserModelId` 已设置，利于通知与应用标识。

### 5.2 同步时间（定时抓取间隔）

- UI：**设置页**保存分钟数；主进程 `**set-sync-interval-minutes`** 写入 `**config.yaml**` 的 `**widget_refresh_minutes**`。
- 小组件 `**widget.js**`：用 `**getRefreshMinutes()**` 启动定时器；监听 `**prefs-changed**` 会 **清除旧 `setInterval` 再按新间隔重建**（避免改了设置仍用旧周期）。
- Python 侧默认值：`python/paths.py` 中 `**WIDGET_REFRESH_MINUTES_DEFAULT = 30`**，与 `electron/main.js` 中 `**DEFAULT_WIDGET_REFRESH_MINUTES**` 语义一致。

### 5.3 待办预警（系统通知）

- 开关与档位：见 `main.js` `**DEFAULT_STARTUP_PREFS**`（`alertEnabled`、`alertThreeDay` / `alertOneDay` / `alertUrgent`、各档 `**alertCooldown*Min**`、`alertPollMinutes`）。
- **时间分档（按剩余小时 `h`）** — `tierForHours` in `main.js`：
  - `**urgent`**：`0 < h ≤ 24`（文案：不足 24 小时）
  - `**oneDay**`：`24 < h ≤ 48`（约 1～2 天内）
  - `**threeDay**`：`48 < h ≤ 72`（约 2～3 天内）
  - 超出 72 小时或已过期（`h ≤ 0`）不由此逻辑预警。
- 主进程按 `**alertPollMinutes**` 定时调用 `**runAlertCheck()**`；同一条目同一档位在冷却时间内不重复发通知，状态持久化在 `**alert_notify_state.json**`。
- 依赖：`**Notification.isSupported()**`；用户需在系统中允许该应用通知。

### 5.4 其他偏好（设置页）

- **开机启动**：`openAtLogin`，`setLoginItemSettings`（开发模式与打包路径分支见 `applyOpenAtLogin`）。
- **启动后自动同步一次**：`autoSyncOnLaunch`，`scheduleLaunchSync()` 延迟约 2.5s 调 `**runFetch()`**。

### 5.5 启动时打开哪些窗口

- 偏好键：`startupOpenMode`：`home` | `widget` | `both`，在 **设置** 与 **首启向导** 中共用；主进程 `**applyStartupWindows()**` 在 `**app.whenReady**` 与 **完成首启** 时按此创建主页 / 小组件。
- 设置页修改后 **下次启动** 生效（本次会话可在主页手动打开小组件）。
- 旧安装无该字段时迁移为 `home`（保持原先「只开主页」行为）；全新安装默认偏好可为 `widget`（见 `DEFAULT_STARTUP_PREFS`）。

### 5.6 首次运行向导

- `onboardingDone: false` 且未完成迁移 / 无已有会话时，打开 `electron/onboarding/`；完成后 `**complete-onboarding**` IPC 写入 `onboardingDone: true` 并 `**applyStartupWindows**`。
- 重装后若 `electron_prefs.json` 仍在，不再显示向导。

---

## 6. IPC 一览（`preload.js` → `main.js`）


| 渲染侧 API                                                       | 作用                                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `getCache` / `runFetch` / `getRefreshMinutes`                 | 读缓存、触发抓取、读同步间隔（分钟）                                                                            |
| `getStartupPrefs` / `setStartupPrefs`                         | 读写 `electron_prefs.json` 中多项偏好；保存后会 `**restartAlertScheduler**` + `**broadcastPrefsChanged**` |
| `getTheme` / `setTheme`                                       | 读写主题                                                                                          |
| `getSyncIntervalMinutes` / `setSyncIntervalMinutes`           | 读写同步间隔（写 `config.yaml` 并 `**broadcastPrefsChanged**`）                                         |
| `openSettingsWindow` / `openLoginWindow` / `openWidgetWindow` | 打开对应窗口                                                                                        |
| `onCacheUpdated`                                              | 主进程抓取完成后广播（登录窗可能被排除，见 `broadcastCacheUpdated`）                                                |
| `onThemeChanged`                                              | `theme-changed`                                                                               |
| `onPrefsChanged`                                              | `prefs-changed`（主题以外的偏好变更也会走这里，用于刷新小组件定时等）                                                    |
| `completeOnboarding`                                          | 首启结束：合并偏好、`onboardingDone: true`、关闭向导窗、`applyStartupWindows`                                                   |


---

## 7. 已完成的重要修复（近期）

- 主页 `**home.js**` 已去掉已删除 DOM（开机勾选等）的引用，避免运行时错误；**「设置」** 按钮接 `**openSettingsWindow`**；`**onPrefsChanged**` 刷新缓存概览。
- 小组件已挂 `**themes.css` + `theme-init.js**`，并在 `**prefs-changed**` 时重建自动同步定时器。

---

## 8. 建议下一任优先核对 / 可选增强

1. **冒烟**：`npm start` → 打开设置保存、改主题、改同步分钟并确认 `**config.yaml`** 与小组件页脚间隔文案一致；Windows 下确认通知权限。
2. **文档**：若对外说明，可在 `项目说明.md` / `docs/STRUCTURE.md` 中增加指向 `**docs/HANDOFF.md`** 或合并精简一节（当前HANDOFF为交接专用，可按需裁剪给用户）。
3. **样式**：`home.css` 中 `.btn.primary` / `.btn.accent` 已与主题变量对齐（`color-mix` + `--accent` / `--accent2`）；若仍有个别控件偏色可再扫一遍。
4. **Electron 旧版本**：若降级 Electron，需确认 `**color-mix()`** 在小组件按钮上的兼容性（必要时改回 `rgba`）。

---

## 9. 联系人 / 版本

- 文档生成语境：**2026 年** 迭代中的 Electron + Python 作业待办小工具。
- 交接后请在提交或 PR 中更新本文档日期与变更摘要，便于后续会话检索。

### 变更摘要（维护者可追加）

- **2026-05-05**：大幅改进网络抓取诊断能力、新增登录状态检测、增加更多页面路由尝试、修复若干 bug、完善测试与错误提示。详见 `HANDOFF_CLAUDE.md`。
- **2026-05-04**：主页 `electron/home/home.css` 中 `.btn.primary` / `.btn.accent` 改为基于 `var(--accent)` / `var(--accent2)` 的 `color-mix`，浅色主题下不再沿用深色固定色值；`docs/项目说明.md` 增加指向本文档的链接。

