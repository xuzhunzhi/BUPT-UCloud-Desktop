"""数据目录：优先环境变量 BUPT_DATA_DIR（打包后由 Electron 设为 userData），否则为仓库根目录。"""
from __future__ import annotations

import os
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent


def data_dir() -> Path:
    env = os.environ.get("BUPT_DATA_DIR")
    if env:
        p = Path(env)
        p.mkdir(parents=True, exist_ok=True)
        return p
    if SCRIPT_DIR.name == "python":
        root = SCRIPT_DIR.parent
        root.mkdir(parents=True, exist_ok=True)
        return root
    p = SCRIPT_DIR
    p.mkdir(parents=True, exist_ok=True)
    return p


DATA_DIR = data_dir()

# 与 electron/main.js 中默认一致：小组件定时爬取间隔（分钟）
WIDGET_REFRESH_MINUTES_DEFAULT = 30
