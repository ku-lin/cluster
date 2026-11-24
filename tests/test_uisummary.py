"""uisummary 单元测试：首屏那三块纯数据变换。

这些函数决定"一眼能不能看对状态"，所以最小集是：
  1. queue_summary 分类不漏不重（未知状态进 unknown，总数仍等于分桶和）；
  2. push_point 幂等 + 环形裁剪（同一 ts 不叠点，超限丢最旧的）；
  3. workspace_summary 把 last_run 的 counts 提上来（面板直接读 last.status/last.counts）。
"""

from __future__ import annotations

import unittest

from cluster import uisummary


class TestQueueSummary(unittest.TestCase):
    def test_buckets_cover_all_statuses(self):
        tasks = [
            {"status": "pending"},
            {"status": "queued"},
            {"status": "claimed"},
            {"status": "running"},
            {"status": "running"},
            {"status": "done"},
            {"status": "failed"},
            {"status": "cancelled"},
        ]
        result = uisummary.queue_summary(tasks)
        self.assertEqual(result["total"], 8)
        self.assertEqual(result["counts"]["waiting"], 2)
        self.assertEqual(result["counts"]["running"], 3)
        self.assertEqual(result["counts"]["done"], 1)
        self.assertEqual(result["counts"]["failed"], 1)
        self.assertEqual(result["counts"]["cancelled"], 1)
        self.assertEqual(result["counts"]["unknown"], 0)
        self.assertEqual(sum(result["counts"].values()), result["total"])

    def test_unknown_status_is_kept_not_dropped(self):
        result = uisummary.queue_summary([{"status": "weird"}, {"status": None}, {"status": "done"}])
        self.assertEqual(result["counts"]["unknown"], 2)
        self.assertEqual(result["total"], 3)
        self.assertEqual(sum(result["counts"].values()), 3)

    def test_empty_and_noise(self):
        self.assertEqual(uisummary.queue_summary(None)["total"], 0)
        self.assertEqual(uisummary.queue_summary([None, "x", {"status": "done"}])["total"], 1)


class TestHistory(unittest.TestCase):
    def test_push_is_idempotent_on_same_ts(self):
        history: dict[str, list[dict]] = {}
        uisummary.push_point(history, "win-node", {"ts": 100.0, "cpu": 10})
        uisummary.push_point(history, "win-node", {"ts": 100.0, "cpu": 20})
        self.assertEqual(len(history["win-node"]), 1)
        self.assertEqual(history["win-node"][0]["cpu"], 20)

    def test_push_trims_ring(self):
        history: dict[str, list[dict]] = {}
        for index in range(10):
            uisummary.push_point(history, "n1", {"ts": float(index + 1), "cpu": index}, limit=4)
        series = history["n1"]
        self.assertEqual(len(series), 4)
        self.assertEqual(series[0]["ts"], 7.0)
        self.assertEqual(series[-1]["ts"], 10.0)

    def test_non_numeric_metrics_are_skipped_not_zeroed(self):
        history: dict[str, list[dict]] = {}
        uisummary.push_point(history, "n1", {"ts": 5.0, "cpu": None, "mem": 42.5})
        row = history["n1"][0]
        self.assertNotIn("cpu", row)  # 缺就是缺，不能填 0 冒充实时值
        self.assertEqual(row["mem"], 42.5)

    def test_history_of_limits_window(self):
        history = {"n1": [{"ts": float(i)} for i in range(5)]}
        self.assertEqual(len(uisummary.history_of(history, "n1", limit=2)), 2)
        self.assertEqual(uisummary.history_of(history, "nope"), [])


class TestWorkspaceSummary(unittest.TestCase):
    def test_last_run_counts_are_lifted(self):
        record = {"name": "demo", "policy": "newest", "created": 1.0, "last_run": "sync-1", "last_status": "partial"}
        runs = {
            "sync-1": {
                "id": "sync-1",
                "status": "partial",
                "counts": {"files": 4, "in_sync": 3, "copied": 1, "conflicts": 2, "failed": 1},
                "nodes": {"win-node": {"node_id": "win-node", "status": "ready", "written": 1, "errors": ["x"]}},
            }
        }
        result = uisummary.workspace_summary(record, runs)
        self.assertEqual(result["last_status"], "partial")
        self.assertEqual(result["last"]["counts"]["conflicts"], 2)
        self.assertEqual(result["last"]["counts"]["failed"], 1)
        self.assertEqual(result["last"]["nodes"][0]["node_id"], "win-node")

    def test_missing_run_does_not_fake_success(self):
        result = uisummary.workspace_summary({"name": "fresh", "created": 2.0}, {})
        self.assertIsNone(result["last"])
        self.assertIsNone(result["last_status"])


if __name__ == "__main__":
    unittest.main()
