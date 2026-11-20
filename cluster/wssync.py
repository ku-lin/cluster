"""工作区同步引擎：多节点 manifest 比对 → 冲突判定 → 复制 → 逐项重试。

设计取舍
--------
* **节点侧无状态**：真正读写文件的是每个节点上的 `skill:ws@1.0.0`（examples/plugins/skills/ws），
  它只提供 manifest / read / write 三个原子操作。合并策略、冲突判定、重试都在这里，
  所以重试 = 重发同一条 /invoke，不需要节点保留上次同步的任何中间状态。
* **定向寻址**：同步天生是"每个节点各一份"，所以走 Node Agent 的 `/invoke` 直接点名到节点，
  而不是让 L2 Router 按负载挑一个（那样两个节点拿不到各自的清单）。
  路由/派单场景才用 L2 的 `/control/tasks`（见 ui_api 的 Router 命令）。
* **不编造状态**：节点不可达就是 `unreachable`，读失败就是 `failed`，冲突一定带双方 sha256；
  没有"部分成功当成全部成功"的分支。

磁盘布局
--------
`<workspace>/` 在每个节点上是独立目录：
    Windows: <repo>/.state/workspaces/<name>
    Linux  : ~/cluster-test/workspaces/<name>
"""

from __future__ import annotations

import base64
import hashlib
import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

WS_CAP = "skill:ws@1.0.0"
SKIP_NAMES = [".git", "__pycache__", "node_modules", ".venv", "node_modules"]
TERMINAL_BAD = ("failed", "unreachable")


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def normalize_policy(policy: str | None) -> str:
    """只接受 `newest` 与 `prefer:<node_id>`；其他一律退回 `newest`。

    （早先这里写的是 `policy in ("newest", "prefer")`，于是前端传的 `prefer:win-node`
    会被静默降级成 `newest` —— 策略看着选了、其实没生效，是单元测试抓出来的。）
    """
    text = str(policy or "").strip()
    if text == "newest":
        return "newest"
    if text.startswith("prefer:") and text.split(":", 1)[1].strip():
        return f"prefer:{text.split(':', 1)[1].strip()}"
    return "newest"


class WorkspaceError(RuntimeError):
    pass


class SyncEngine:
    """一个进程内的工作区登记表 + 同步运行记录。

    call_node(node_id, args, timeout) -> (ok, output, error, elapsed_ms)
        ui_api 提供：定位节点可达 URL 并 POST /invoke 到 `skill:ws@1.0.0`。
    list_nodes() -> [{"node_id","os","alive","url",...}]
    """

    def __init__(
        self,
        state_path: str | Path,
        call_node: Callable[[str, dict, float], dict],
        list_nodes: Callable[[], list[dict]],
        win_root_base: str,
        linux_root_base: str,
        journal: Callable[[str], None] | None = None,
    ) -> None:
        self.state_path = Path(state_path)
        self.call_node = call_node
        self.list_nodes = list_nodes
        self.win_root_base = win_root_base.rstrip("/\\")
        self.linux_root_base = linux_root_base.rstrip("/")
        self.journal = journal or (lambda _msg: None)
        self._lock = threading.RLock()
        self.workspaces: dict[str, dict] = {}
        self.runs: dict[str, dict] = {}
        self._load()

    # ------------------------------------------------------------ 持久化
    def _load(self) -> None:
        if not self.state_path.exists():
            return
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            self.journal(f"state 读取失败（忽略）: {exc}")
            return
        self.workspaces = data.get("workspaces") or {}
        self.runs = data.get("runs") or {}

    def _save(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"workspaces": self.workspaces, "runs": self.runs, "saved": time.time()}
        tmp = self.state_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        tmp.replace(self.state_path)

    # ------------------------------------------------------------ 工作区
    def default_root(self, os_name: str | None, name: str) -> str:
        if (os_name or "").lower().startswith("win"):
            return f"{self.win_root_base}\\{name}"
        return f"{self.linux_root_base}/{name}"

    def roots_for(self, workspace: dict) -> dict[str, str]:
        """把工作区声明的根路径补齐到当前活着的每个节点。"""
        roots = dict(workspace.get("roots") or {})
        for node in self.list_nodes():
            node_id = str(node.get("node_id"))
            if node_id and node_id not in roots:
                roots[node_id] = self.default_root(node.get("os"), workspace["name"])
        return roots

    def create_workspace(self, name: str, policy: str = "newest", seed: bool = True,
                         roots: dict[str, str] | None = None) -> dict:
        name = (name or "").strip()
        if not name or any(ch in name for ch in "\\/:*?\"<>|"):
            raise WorkspaceError("工作区名不合法（不能为空，不能含 \\ / : * ? \" < > |）")
        with self._lock:
            if name in self.workspaces:
                raise WorkspaceError(f"工作区已存在: {name}")
            record = {
                "name": name,
                "created": time.time(),
                "policy": normalize_policy(policy),
                "roots": roots or {},
                "seeded": False,
                "last_run": None,
                "last_status": None,
            }
            self.workspaces[name] = record
            self._save()
        if seed:
            record["seed"] = self._seed(name)
            record["seeded"] = True
            with self._lock:
                self._save()
        return self.workspaces[name]

    def _seed(self, name: str) -> dict:
        """在工作区里放最小的可同步内容（真实文件，不是假数据）。

        有内容才谈得上"同步"：空目录在两端天然一致，跑一轮会得到 0 个文件，
        既无法验证链路，也无法展示冲突。这里写 3 个小文件，随首轮同步真的传到对端。
        """
        nodes = {str(n.get("node_id")): n for n in self.list_nodes() if n.get("alive")}
        target = next((nid for nid, n in nodes.items() if str(n.get("os", "")).lower().startswith("win")), None)
        target = target or (next(iter(nodes), None))
        if target is None:
            return {"ok": False, "error": "没有活着的节点，无法播种"}
        root = self.roots_for(self.workspaces[name]).get(target) or self.default_root(nodes[target].get("os"), name)
        files = {
            "README.md": (
                f"# cluster 工作区 {name}\n\n"
                f"由 DSH「Cluster」面板创建于 {time.strftime('%Y-%m-%d %H:%M:%S')}。\n\n"
                "这个目录会在集群所有节点上保持一致：网关按节点清单（path/size/sha256/mtime）比对，\n"
                "只同步差异文件，冲突按策略裁决并逐项可重试。\n"
            ),
            "tasks.json": json.dumps(
                {"workspace": name, "nodes_target": sorted(nodes), "created": time.time()}, ensure_ascii=False, indent=2
            ),
            "notes/hello.txt": "hello from the cluster workspace\n",
        }
        written = []
        for rel, text in files.items():
            path = self._join(root, rel, nodes[target].get("os"))
            data = text.encode("utf-8")
            args = {
                "op": "write",
                "path": path,
                "data_b64": base64.b64encode(data).decode("ascii"),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
            result = self.call_node(target, args, 20.0)
            written.append({"path": path, "ok": result.get("ok"), "error": result.get("error")})
        return {"ok": all(item["ok"] for item in written), "node_id": target, "root": root, "files": written}

    def workspace_view(self, name: str) -> dict:
        record = self.workspaces[name]
        return {**record, "roots": self.roots_for(record)}

    # ------------------------------------------------------------ 同步
    def start_sync(self, name: str, policy: str | None = None, parent_run: str | None = None) -> dict:
        if name not in self.workspaces:
            raise WorkspaceError(f"没有这个工作区: {name}")
        run = {
            "id": new_id("sync"),
            "workspace": name,
            "status": "running",
            "policy": normalize_policy(policy or self.workspaces[name].get("policy")),
            "created": time.time(),
            "updated": time.time(),
            "finished": None,
            "attempt": 1,
            "parent_run": parent_run,
            "nodes": {},
            "items": [],
            "conflicts": [],
            "counts": {"files": 0, "in_sync": 0, "copied": 0, "conflicts": 0, "failed": 0},
            "error": None,
            "log": [],
        }
        with self._lock:
            self.runs[run["id"]] = run
            self._save()
        thread = threading.Thread(target=self._run_sync, args=(run,), name=f"sync-{run['id']}", daemon=True)
        thread.start()
        return run

    def _log(self, run: dict, message: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        run["log"].append(f"{stamp} {message}")
        run["log"] = run["log"][-200:]
        self.journal(f"[{run['id']}] {message}")

    def _run_sync(self, run: dict) -> None:
        try:
            self._sync_once(run)
        except Exception as exc:  # noqa: BLE001 - 后台线程不能把网关带崩
            run["status"] = "failed"
            run["error"] = f"{type(exc).__name__}: {exc}"
            self._log(run, f"运行失败: {run['error']}")
        finally:
            run["updated"] = time.time()
            run["finished"] = run["finished"] or time.time()
            with self._lock:
                workspace = self.workspaces.get(run["workspace"])
                if workspace:
                    workspace["last_run"] = run["id"]
                    workspace["last_status"] = run["status"]
                self._save()

    # ------------------------------------------------------------ 一轮比对
    def _sync_once(self, run: dict) -> None:
        workspace = self.workspaces[run["workspace"]]
        roots = self.roots_for(workspace)
        targets = [n for n in self.list_nodes() if n.get("alive")]
        for node in targets:
            run["nodes"][str(node["node_id"])] = {
                "node_id": node["node_id"], "os": node.get("os"), "root": roots.get(str(node["node_id"])),
                "status": "pending", "manifest_files": 0, "written": 0, "unchanged": 0, "errors": [],
            }
        self._log(run, f"目标节点 {[n['node_id'] for n in targets]}")

        # 1) 各节点清单（并发）
        manifests: dict[str, dict[str, dict]] = {}
        results: dict[str, dict] = {}

        def fetch(node: dict) -> None:
            node_id = str(node["node_id"])
            resp = self.call_node(node_id, {"op": "manifest", "root": roots.get(node_id), "skip": SKIP_NAMES}, 45.0)
            results[node_id] = resp

        threads = [threading.Thread(target=fetch, args=(node,), daemon=True) for node in targets]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)

        for node in targets:
            node_id = str(node["node_id"])
            entry = run["nodes"][node_id]
            resp = results.get(node_id)
            if resp is None:
                entry["status"] = "unreachable"
                entry["errors"].append("清单请求超时")
                continue
            if not resp.get("ok"):
                entry["status"] = "unreachable"
                entry["errors"].append(resp.get("error") or "清单请求失败")
                continue
            output = resp.get("output") or {}
            files = output.get("files") or []
            manifests[node_id] = {item["path"]: item for item in files}
            entry["status"] = "ready"
            entry["manifest_files"] = len(files)
            entry["skipped"] = output.get("skipped") or []
            entry["exists"] = output.get("exists")
            if output.get("skipped"):
                entry["errors"].extend(f"{s['path']}: {s['reason']}" for s in output["skipped"][:20])

        ready = [nid for nid, row in run["nodes"].items() if row["status"] == "ready"]
        if len(ready) < 2:
            run["status"] = "failed"
            run["error"] = f"可用节点不足（{len(ready)}），无法比对；检查各节点 skill:ws 是否在线"
            self._log(run, run["error"])
            return

        # 2) 逐文件裁决
        all_paths = sorted({path for manifest in manifests.values() for path in manifest})
        run["counts"]["files"] = len(all_paths)
        items: list[dict] = []
        conflicts: list[dict] = []
        for path in all_paths:
            present = {nid: manifests[nid][path] for nid in ready if path in manifests[nid]}
            shas = {item["sha256"] for item in present.values()}
            item = {
                "path": path,
                "status": "in_sync",
                "sha_by_node": {nid: item["sha256"] for nid, item in present.items()},
                "size": next(iter(present.values()))["size"] if present else 0,
                "from": None,
                "to": [],
                "error": None,
            }
            if len(present) == len(ready) and len(shas) == 1:
                run["counts"]["in_sync"] += 1
                items.append(item)
                continue
            source = self._pick_source(run, present, ready)
            if len(shas) > 1:
                conflict = {
                    "path": path,
                    "sha_by_node": item["sha_by_node"],
                    "mtime_by_node": {nid: item["mtime_ns"] for nid, item in present.items()},
                    "winner": source,
                    "policy": run["policy"],
                    "resolved": True,
                }
                conflicts.append(conflict)
                run["counts"]["conflicts"] += 1
                item["status"] = "conflict"
            else:
                item["status"] = "missing_on_some"
            item["from"] = source
            item["to"] = [nid for nid in ready if nid != source and present.get(source, {}).get("sha256") !=
                          present.get(nid, {}).get("sha256")]
            items.append(item)

        run["conflicts"] = conflicts
        run["items"] = items

        # 3) 复制（只搬差异）
        pending = [item for item in items if item["to"]]
        self._log(run, f"文件 {len(all_paths)} 个：同步 {len(all_paths) - len(pending)}，待复制 {len(pending)}，冲突 {len(conflicts)}")
        self._apply(run, pending, ready)

        run["counts"]["copied"] = sum(row["written"] for row in run["nodes"].values())
        run["counts"]["failed"] = sum(1 for item in items if item["error"])
        for item in items:
            if item["error"]:
                item["status"] = "failed"
        if run["status"] == "running":
            if run["counts"]["failed"] == 0 and not any(row["status"] == TERMINAL_BAD[1] for row in run["nodes"].values()):
                run["status"] = "done"
            else:
                run["status"] = "partial"
        run["updated"] = time.time()
        run["finished"] = time.time()
        self._log(run, f"结束: {run['status']} 复制 {run['counts']['copied']} 失败 {run['counts']['failed']}")

    def _pick_source(self, run: dict, present: dict[str, dict], ready: list[str]) -> str | None:
        if not present:
            return None
        policy = run.get("policy") or "newest"
        if policy.startswith("prefer:"):
            preferred = policy.split(":", 1)[1]
            if preferred in present:
                return preferred
        return max(present.items(), key=lambda kv: kv[1].get("mtime_ns", 0))[0]

    def _apply(self, run: dict, pending: list[dict], ready: list[str]) -> None:
        roots = self.roots_for(self.workspaces[run["workspace"]])
        for item in pending:
            source = item["from"]
            if not source:
                item["error"] = "no_source"
                continue
            source_path = self._join(roots[source], item["path"], run["nodes"][source].get("os"))
            read = self.call_node(source, {"op": "read", "path": source_path}, 45.0)
            if not read.get("ok"):
                item["error"] = f"read@{source}: {read.get('error')}"
                run["nodes"][source]["errors"].append(item["error"])
                self._log(run, f"读失败 {item['path']} @{source}: {read.get('error')}")
                continue
            payload = read.get("output") or {}
            if payload.get("sha256") != item["sha_by_node"].get(source):
                item["error"] = f"read@{source}: sha256 与清单不一致（文件在同步过程中被改动）"
                run["nodes"][source]["errors"].append(item["error"])
                continue
            for target in item["to"]:
                target_path = self._join(roots[target], item["path"], run["nodes"][target].get("os"))
                write = self.call_node(
                    target,
                    {"op": "write", "path": target_path, "data_b64": payload.get("data_b64"), "sha256": payload.get("sha256")},
                    45.0,
                )
                if not write.get("ok"):
                    item["error"] = f"write@{target}: {write.get('error')}"
                    run["nodes"][target]["errors"].append(item["error"])
                    self._log(run, f"写失败 {item['path']} -> {target}: {write.get('error')}")
                    continue
                action = (write.get("output") or {}).get("action")
                if action == "written":
                    run["nodes"][target]["written"] += 1
                else:
                    run["nodes"][target]["unchanged"] += 1
            if not item["error"]:
                item["status"] = "copied" if item["status"] != "conflict" else "conflict"
                self._log(run, f"复制 {item['path']} {source} -> {item['to']}")

    @staticmethod
    def _join(root: str, rel: str, os_name: str | None) -> str:
        """把工作区相对路径拼到某个节点的根上（Windows 用反斜杠，其余用斜杠）。"""
        if str(os_name or "").lower().startswith("win"):
            return f"{root.rstrip(chr(92))}\\{rel.replace('/', chr(92))}"
        return f"{root.rstrip('/')}/{rel}"

    # ------------------------------------------------------------ 重试
    def retry(self, run_id: str) -> dict:
        run = self.runs.get(run_id)
        if not run:
            raise WorkspaceError(f"没有这次同步: {run_id}")
        if run["status"] == "running":
            raise WorkspaceError("这次同步还在跑，先等它结束")
        failing = [item for item in run["items"] if item.get("error") or item["status"] == "missing_on_some"]
        if not failing:
            raise WorkspaceError("这次同步没有失败项")
        run["status"] = "running"
        run["attempt"] += 1
        run["finished"] = None
        for item in failing:
            item["error"] = None
            item["retried"] = item.get("retried", 0) + 1
        with self._lock:
            self._save()

        def work() -> None:
            try:
                ready = [nid for nid, row in run["nodes"].items() if row["status"] == "ready"]
                self._log(run, f"重试 {len(failing)} 项（第 {run['attempt']} 次）")
                self._apply(run, failing, ready)
                run["counts"]["failed"] = sum(1 for item in run["items"] if item.get("error"))
                run["status"] = "done" if run["counts"]["failed"] == 0 else "partial"
            except Exception as exc:  # noqa: BLE001
                run["status"] = "failed"
                run["error"] = f"{type(exc).__name__}: {exc}"
            finally:
                run["updated"] = time.time()
                run["finished"] = time.time()
                with self._lock:
                    workspace = self.workspaces.get(run["workspace"])
                    if workspace:
                        workspace["last_status"] = run["status"]
                    self._save()

        threading.Thread(target=work, name=f"retry-{run_id}", daemon=True).start()
        return run

    # ------------------------------------------------------------ 查询
    def status(self, run_id: str | None = None) -> dict[str, Any]:
        if run_id:
            run = self.runs.get(run_id)
            if not run:
                raise WorkspaceError(f"没有这次同步: {run_id}")
            return {"run": run}
        runs = sorted(self.runs.values(), key=lambda r: r["created"], reverse=True)[:10]
        return {"runs": runs, "count": len(self.runs)}
