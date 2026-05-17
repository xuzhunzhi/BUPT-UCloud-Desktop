"""日志工具：同时输出到 stdout/stderr 和文件。"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

from paths import DATA_DIR

LOG_PATH = DATA_DIR / "app.log"


def _write_log(level: str, msg: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] [{level}] {msg}"
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    if level == "ERROR":
        print(line, file=sys.stderr, flush=True)
    else:
        print(line, flush=True)


def info(msg: str) -> None:
    _write_log("INFO", msg)


def warn(msg: str) -> None:
    _write_log("WARN", msg)


def error(msg: str) -> None:
    _write_log("ERROR", msg)
