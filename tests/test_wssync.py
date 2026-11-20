"""wssync 单元测试：不碰网络、不碰真实文件，用内存里的假节点跑同步决策。

覆盖三件事（也就是这个引擎真正容易错的地方）：
  1. 只搬运差异：单侧有的文件要复制过去，两边一致的不动；
  2. 冲突裁决：sha256 不同 -> 记冲突并按策略（newest / prefer:<node>）选源，之后两端一致；
  3. 重试：写失败 -> 记 failed 并保留错误；清掉故障后 retry 只重跑失败项（retried+1）。

假节点实现 `/invoke` 的四个 op（manifest/read/write/stat），路径按各节点根前缀剥掉，
所以引擎拼出来的绝对路径（Windows 反斜杠 / Linux 正斜杠）也被顺带验证了。
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from cluster.wssync import SyncEngine, WorkspaceError


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class FakeCluster:
    def __init__(self, roots: dict[str, str], files: dict[str, dict[str, bytes]] | None = None) -> None:
        self.roots = roots
        self.files = {node: dict(items) for node, items in (files or {}).items()}
        for node in roots:
            self.files.setdefault(node, {})
        self.mtimes = {}
        self.fail_write: dict[str, str] = {}
        self.calls = []
        base = time.time() - 1000
        for index, (node, items) in enumerate(self.files.items()):
            for offset, rel in enumerate(items):
                self.mtimes[(node, rel)] = int((base + index * 100 + offset) * 1_000_000_000)

    # -- 供 SyncEngine 注入的两件事 -----------------------------------
    def list_nodes(self):
        return [{"node_id": node, "os": "windows" if node.startswith("win") else "linux", "alive": True} for node in self.roots]

    def call_node(self, node_id, args, timeout):
        self.calls.append((node_id, args.get("op")))
        root = self.roots[node_id]
        op = args.get("op")
        if op == "manifest":
            rows = [
                {"path": rel, "size": len(data), "sha256": _sha(data), "mtime_ns": self.mtimes[(node_id, rel)]}
                for rel, data in self.files[node_id].items()
            ]
            return {"ok": True, "output": {"ok": True, "root": root, "exists": True, "files": rows, "skipped": [], "files_scanned": len(rows)}}
        if op == "read":
            rel = self._rel(root, args["path"])
            data = self.files[node_id].get(rel)
            if data is None:
                return {"ok": False, "error": "missing", "output": None}
            import base64

            return {"ok": True, "output": {"ok": True, "path": args["path"], "size": len(data), "sha256": _sha(data),
                                           "data_b64": base64.b64encode(data).decode("ascii")}}
        if op == "write":
            rel = self._rel(root, args["path"])
            if node_id in self.fail_write:
                return {"ok": False, "error": self.fail_write[node_id], "output": None}
            import base64

            data = base64.b64decode(args["data_b64"])
            if _sha(data) != args["sha256"]:
                return {"ok": False, "error": "sha mismatch", "output": None}
            existed = rel in self.files[node_id]
            self.files[node_id][rel] = data
            self.mtimes[(node_id, rel)] = time.time_ns()
            return {"ok": True, "output": {"ok": True, "path": args["path"], "action": "unchanged" if existed else "written",
                                           "size": len(data), "sha256": _sha(data)}}
        if op == "stat":
            return {"ok": True, "output": {"ok": True, "exists": True, "is_dir": True, "size": 0, "mtime_ns": 0}}
        return {"ok": False, "error": f"unsupported op {op}", "output": None}

    @staticmethod
    def _rel(root: str, path: str) -> str:
        normalized_root = root.replace("\\", "/").rstrip("/")
        return path.replace("\\", "/").split(normalized_root + "/", 1)[-1]


class SyncEngineTest(unittest.TestCase):
    def make_engine(self, cluster: FakeCluster, policy: str = "newest", state_dir: str | None = None):
        directory = state_dir or tempfile.mkdtemp(prefix="wssync-test-")
        engine = SyncEngine(
            state_path=Path(directory) / "workspaces.json",
            call_node=cluster.call_node,
            list_nodes=cluster.list_nodes,
            win_root_base="D:\\ws-root",
            linux_root_base="~/cluster-test/workspaces",
        )
        return engine, directory

    def run_sync(self, engine: SyncEngine, name: str) -> dict:
        run = engine.start_sync(name)
        deadline = time.time() + 5
        while time.time() < deadline and run["status"] == "running":
            time.sleep(0.02)
        self.assertNotEqual(run["status"], "running", "同步线程没有在 5s 内结束")
        return run

    def test_copies_only_missing_files(self):
        cluster = FakeCluster(
            {"win-node": "D:\\ws-root\\ws1", "kali-node": "~/cluster-test/workspaces/ws1"},
            {"win-node": {"README.md": b"# hi\n", "notes/a.txt": b"a"}, "kali-node": {"notes/a.txt": b"a"}},
        )
        engine, _ = self.make_engine(cluster)
        engine.create_workspace("ws1", seed=False)
        run = self.run_sync(engine, "ws1")
        self.assertEqual(run["status"], "done", json.dumps(run["log"], ensure_ascii=False))
        self.assertEqual(run["counts"]["files"], 2)
        self.assertEqual(run["counts"]["in_sync"], 1)
        self.assertEqual(run["counts"]["copied"], 1)
        self.assertEqual(cluster.files["kali-node"]["README.md"], b"# hi\n")
        self.assertEqual(len(run["conflicts"]), 0)

    def test_conflict_newest_wins_and_both_sides_converge(self):
        cluster = FakeCluster(
            {"win-node": "D:\\ws-root\\ws2", "kali-node": "~/cluster-test/workspaces/ws2"},
            {"win-node": {"a.txt": b"old"}, "kali-node": {"a.txt": b"newer"}},
        )
        # kali 的 mtime 更新（更晚建的那条）
        cluster.mtimes[("kali-node", "a.txt")] = cluster.mtimes[("win-node", "a.txt")] + 10_000_000_000
        engine, _ = self.make_engine(cluster)
        engine.create_workspace("ws2", policy="newest", seed=False)
        run = self.run_sync(engine, "ws2")
        self.assertEqual(run["status"], "done")
        self.assertEqual(run["counts"]["conflicts"], 1)
        conflict = run["conflicts"][0]
        self.assertEqual(conflict["path"], "a.txt")
        self.assertEqual(conflict["winner"], "kali-node")
        self.assertEqual(set(conflict["sha_by_node"]), {"win-node", "kali-node"})
        self.assertEqual(cluster.files["win-node"]["a.txt"], b"newer")

    def test_conflict_prefer_policy(self):
        cluster = FakeCluster(
            {"win-node": "D:\\ws-root\\ws3", "kali-node": "~/cluster-test/workspaces/ws3"},
            {"win-node": {"a.txt": b"win"}, "kali-node": {"a.txt": b"kali"}},
        )
        engine, _ = self.make_engine(cluster)
        engine.create_workspace("ws3", policy="prefer:win-node", seed=False)
        run = self.run_sync(engine, "ws3")
        self.assertEqual(run["conflicts"][0]["winner"], "win-node")
        self.assertEqual(cluster.files["kali-node"]["a.txt"], b"win")

    def test_failed_write_then_retry(self):
        cluster = FakeCluster(
            {"win-node": "D:\\ws-root\\ws4", "kali-node": "~/cluster-test/workspaces/ws4"},
            {"win-node": {"b.bin": b"payload"}},
        )
        cluster.fail_write["kali-node"] = "PermissionError: locked"
        engine, _ = self.make_engine(cluster)
        engine.create_workspace("ws4", seed=False)
        run = self.run_sync(engine, "ws4")
        self.assertEqual(run["status"], "partial")
        self.assertEqual(run["counts"]["failed"], 1)
        item = next(row for row in run["items"] if row["path"] == "b.bin")
        self.assertIn("locked", item["error"])
        self.assertEqual(item["status"], "failed")

        del cluster.fail_write["kali-node"]
        engine.retry(run["id"])
        deadline = time.time() + 5
        while time.time() < deadline and run["status"] == "running":
            time.sleep(0.02)
        self.assertEqual(run["status"], "done")
        self.assertEqual(run["attempt"], 2)
        self.assertEqual(item["retried"], 1)
        self.assertEqual(cluster.files["kali-node"]["b.bin"], b"payload")

    def test_retry_without_failures_is_rejected(self):
        cluster = FakeCluster(
            {"win-node": "D:\\ws-root\\ws5", "kali-node": "~/cluster-test/workspaces/ws5"},
            {"win-node": {"ok.txt": b"x"}},
        )
        engine, _ = self.make_engine(cluster)
        engine.create_workspace("ws5", seed=False)
        run = self.run_sync(engine, "ws5")
        self.assertEqual(run["status"], "done")
        with self.assertRaises(WorkspaceError):
            engine.retry(run["id"])

    def test_duplicate_and_invalid_workspace_names(self):
        cluster = FakeCluster({"win-node": "D:\\w", "kali-node": "~/w"})
        engine, _ = self.make_engine(cluster)
        engine.create_workspace("dup", seed=False)
        with self.assertRaises(WorkspaceError):
            engine.create_workspace("dup", seed=False)
        with self.assertRaises(WorkspaceError):
            engine.create_workspace("bad/name", seed=False)

    def test_nodes_unreachable_fails_loudly(self):
        class Dead(FakeCluster):
            def call_node(self, node_id, args, timeout):
                return {"ok": False, "error": "unreachable https://10.14.14.2:17100", "output": None}

        cluster = Dead({"win-node": "D:\\w", "kali-node": "~/w"})
        engine, _ = self.make_engine(cluster)
        engine.create_workspace("dead", seed=False)
        run = self.run_sync(engine, "dead")
        self.assertEqual(run["status"], "failed")
        self.assertIn("可用节点不足", run["error"])
        self.assertEqual(run["nodes"]["win-node"]["status"], "unreachable")


if __name__ == "__main__":
    unittest.main()
