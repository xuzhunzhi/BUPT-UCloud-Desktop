"""数据模型。"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class HomeworkItem:
    title: str
    course: str
    due: str
    raw: str
    url: str = ""
    submitted: bool = False
    content: str = ""
    assignment_id: str = ""


# homework_cache.json 版本，便于以后迁移字段
CACHE_SCHEMA_VERSION = 1
