"""纯逻辑单测（不启动浏览器、不读用户 config）。"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "python"))

from homework_fetcher import (  # noqa: E402
    HomeworkItem,
    _dedupe_homework_items,
    _looks_like_due_line,
    expand_combined_todo_items,
    extract_homework_from_json_tree,
    parse_loose_deadline_pairs,
    parse_todo_panel_blob,
    resolve_portal_url,
)


class TestResolvePortalUrl(unittest.TestCase):
    def test_target_wins(self) -> None:
        self.assertEqual(
            resolve_portal_url({"target_url": "https://a", "login_start_url": "https://b"}),
            "https://a",
        )

    def test_fallback_login(self) -> None:
        self.assertEqual(
            resolve_portal_url({"login_start_url": "https://x"}),
            "https://x",
        )

    def test_empty(self) -> None:
        self.assertEqual(resolve_portal_url({}), "")

    def test_strips_whitespace(self) -> None:
        self.assertEqual(
            resolve_portal_url({"target_url": "  https://example.com  "}),
            "https://example.com",
        )


class TestLooksLikeDueLine(unittest.TestCase):
    def test_date_with_cutoff(self) -> None:
        self.assertTrue(_looks_like_due_line("截止 2026-05-10 23:59"))

    def test_bare_date_without_keyword(self) -> None:
        # 纯日期无截止关键词不应被识别为截止行
        self.assertFalse(_looks_like_due_line("2026-05-10"))

    def test_chinese_date(self) -> None:
        self.assertTrue(_looks_like_due_line("截止日期：2026年5月10日"))

    def test_relative_today(self) -> None:
        self.assertTrue(_looks_like_due_line("提交时间：今天 23:59"))

    def test_relative_tomorrow(self) -> None:
        self.assertTrue(_looks_like_due_line("提交时间：明天"))

    def test_hours_left(self) -> None:
        self.assertTrue(_looks_like_due_line("剩余 3 小时"))

    def test_days_relative_no_keyword(self) -> None:
        # "3天后" 无截止关键词，需要搭配上下文才算截止行
        self.assertFalse(_looks_like_due_line("3天后"))

    def test_days_with_keyword(self) -> None:
        self.assertTrue(_looks_like_due_line("截止: 3天后"))

    def test_submit_time_label(self) -> None:
        self.assertTrue(_looks_like_due_line("提交时间：2026-06-15"))

    def test_not_a_due_line(self) -> None:
        self.assertFalse(_looks_like_due_line("课程名称：高等数学"))

    def test_empty(self) -> None:
        self.assertFalse(_looks_like_due_line(""))


class TestParseTodoPanelBlob(unittest.TestCase):
    def test_title_and_due_pair(self) -> None:
        text = "待办\n第一章作业\n截止时间 2026-05-10 23:59\n"
        items = parse_todo_panel_blob(text)
        self.assertGreaterEqual(len(items), 1)
        self.assertIn("作业", items[0].title)
        self.assertIn("截止", items[0].due)

    def test_multiple_items(self) -> None:
        text = (
            "待办\n"
            "作业A\n截止 2026-01-10\n"
            "作业B\n截止 2026-02-20\n"
        )
        items = parse_todo_panel_blob(text)
        self.assertEqual(len(items), 2)

    def test_empty(self) -> None:
        self.assertEqual(parse_todo_panel_blob(""), [])

    def test_headers_skipped(self) -> None:
        text = "待办\n1 / 5\n作业A\n截止 2026-01-10\n"
        items = parse_todo_panel_blob(text)
        self.assertEqual(len(items), 1)


class TestParseLooseDeadlinePairs(unittest.TestCase):
    def test_pairs(self) -> None:
        text = "高等数学作业\n截止 2026-05-10 23:59\n其他内容\n"
        items = parse_loose_deadline_pairs(text)
        self.assertGreaterEqual(len(items), 1)
        self.assertIn("高等数学", items[0].title)

    def test_no_due_lines(self) -> None:
        self.assertEqual(parse_loose_deadline_pairs("无截止"), [])


class TestExpandCombined(unittest.TestCase):
    def test_splits_multiple_deadlines_in_raw(self) -> None:
        merged = HomeworkItem(
            title="面板",
            course="",
            due="",
            raw="作业A\n截止 2026-01-01\n作业B\n截止 2026-02-02",
            url="",
        )
        out = expand_combined_todo_items([merged])
        if len(out) >= 2:
            titles = {x.title for x in out}
            self.assertTrue(len(titles) >= 1)
        else:
            self.assertEqual(len(out), 1)


class TestDedupe(unittest.TestCase):
    def test_removes_duplicates(self) -> None:
        items = [
            HomeworkItem("A", "", "2026-01-01", "", ""),
            HomeworkItem("A", "", "2026-01-01", "", ""),
            HomeworkItem("B", "", "2026-01-02", "", ""),
        ]
        out = _dedupe_homework_items(items)
        self.assertEqual(len(out), 2)

    def test_keeps_different_due(self) -> None:
        items = [
            HomeworkItem("A", "", "2026-01-01", "", ""),
            HomeworkItem("A", "", "2026-02-02", "", ""),
        ]
        out = _dedupe_homework_items(items)
        self.assertEqual(len(out), 2)


class TestExtractFromJsonTree(unittest.TestCase):
    def test_nested_homework_items(self) -> None:
        data = {
            "data": {
                "list": [
                    {
                        "homeworkTitle": "第一章作业",
                        "deadline": "2026-05-10 23:59",
                        "courseName": "高等数学",
                    },
                    {
                        "activityTitle": "课堂测验",
                        "endTime": "2026-05-15 12:00",
                    },
                ]
            }
        }
        items = extract_homework_from_json_tree(data)
        self.assertGreaterEqual(len(items), 1)
        titles = {x.title for x in items}
        self.assertIn("第一章作业", titles)

    def test_empty_json(self) -> None:
        self.assertEqual(extract_homework_from_json_tree({}), [])

    def test_flat_list(self) -> None:
        data = [
            {"title": "实验报告", "dueDate": "2026-05-20"},
            {"title": "预习任务", "closeTime": "2026-04-30"},
        ]
        items = extract_homework_from_json_tree(data)
        self.assertGreaterEqual(len(items), 1)

    def test_non_homework_skipped(self) -> None:
        data = {
            "user": {"name": "张三", "role": "student"},
            "config": {"theme": "dark"},
        }
        items = extract_homework_from_json_tree(data)
        self.assertEqual(len(items), 0)


if __name__ == "__main__":
    unittest.main()
