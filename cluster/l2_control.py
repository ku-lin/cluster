"""L2 控制面：多副本 Router + 租约/ CAS 认领 + 准入控制 + 任务分派。

"控制面去中心化"的落地：
  - 每个节点都跑同一个 ControlNode，物理上对等，没有专门的"中心机"；
  - 任务认领走 quorum CAS（先投票、过半数才提交），同一版本只可能有一个赢家；
  - 状态用带版本的 KV 复制到各副本，后台 anti-entropy 收敛（取最大版本）。
  - 不做 leader 选举：日常分派靠 CAS 并发认领，全局清理每个副本各自幂等做。
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import httpjson
from .httpjson import TLSOptions
from .l3_capability import Capability, dedupe
from .policy import AdmissionPolicy, admission_ok, load_score

CLAIM_TTL = 8.0
VOTE_TTL = 4.0
NODE_TTL_DEFAULT = 20.0
TASK_STATUSES = ("pending", "queued", "claimed", "running", "done", "failed", "cancelled")


@dataclass
class Entry:
    version: int
    value: Any
    ts: float

    def to_dict(self) -> dict:
        return {"version": self.version, "value": self.value, "ts": self.ts}


class Ledger:
    """带版本的 KV：version 从 1 开始，cas 要求 expected 与当前版本相等。"""

    def __init__(self) -> None:
        self._data: dict[str, Entry] = {}
        self._lock = threading.RLock()

    def get(self, key: str) -> Entry | None:
        with self._lock:
            return self._data.get(key)

    def version(self, key: str) -> int:
        entry = self.get(key)
        return entry.version if entry else 0

    def put(self, key: str, value: Any) -> Entry:
        with self._lock:
            entry = Entry(version=self.version(key) + 1, value=value, ts=time.time())
            self._data[key] = entry
            return entry

    def cas(self, key: str, expected: int, value: Any) -> bool:
        with self._lock:
            if self.version(key) != expected:
                return False
            self._data[key] = Entry(version=expected + 1, value=value, ts=time.time())
            return True

    def dump(self) -> dict[str, dict]:
        with self._lock:
            return {k: v.to_dict() for k, v in self._data.items()}

    def merge(self, remote: dict[str, dict]) -> int:
        """anti-entropy：按 (version, 值的稳定哈希) 取大者，保证收敛。

        额外规则：任务进入终态(done/failed/cancelled)后不能被对端的 running/queued 覆盖——
        各副本的 version 各自递增，纯比版本号会把已完成的任务"退回"运行中。
        """
        changed = 0
        terminal = {"done", "failed", "cancelled"}
        with self._lock:
            for key, raw in (remote or {}).items():
                try:
                    cand = Entry(version=int(raw["version"]), value=raw["value"], ts=float(raw.get("ts", 0)))
                except (KeyError, TypeError, ValueError):
                    continue
                cur = self._data.get(key)
                if cur is None:
                    self._data[key] = cand
                    changed += 1
                    continue
                if key.startswith("tasks/"):
                    cur_status = (cur.value or {}).get("status")
                    cand_status = (cand.value or {}).get("status")
                    if cand_status in terminal and cur_status not in terminal:
                        self._data[key] = Entry(
                            version=max(cur.version, cand.version) + 1, value=cand.value, ts=cand.ts
                        )
                        changed += 1
                        continue
                    if cur_status in terminal and cand_status not in terminal:
                        continue
                if (cand.version, _stable(cand.value)) > (cur.version, _stable(cur.value)):
                    self._data[key] = cand
                    changed += 1
        return changed


def _stable(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)


class QuorumLedger(Ledger):
    """多副本 CAS：向所有副本(含自己)要投票，过半才提交。"""

    def __init__(self, node_id: str, peers: list[str], tls: TLSOptions | None, token: str | None) -> None:
        super().__init__()
        self.node_id = node_id
        self.peers = [p.rstrip("/") for p in peers if p.rstrip("/") != ""]
        self.tls = tls
        self.token = token
        self._votes: dict[tuple[str, int], tuple[str, float]] = {}
        self._votes_lock = threading.Lock()

    @property
    def quorum(self) -> int:
        total = len(self.peers) + 1
        return total // 2 + 1

    # ---- 投票（本副本） ---------------------------------------------
    def vote(self, key: str, base: int, op_id: str) -> bool:
        now = time.time()
        with self._votes_lock:
            for (k, b), (_, ts) in list(self._votes.items()):
                if now - ts > VOTE_TTL:
                    del self._votes[(k, b)]
            held = self._votes.get((key, base))
            if held and held[0] != op_id:
                return False
            if self.version(key) != base:
                return False
            self._votes[(key, base)] = (op_id, now)
            return True

    def commit(self, key: str, base: int, value: Any) -> bool:
        with self._votes_lock:
            self._votes.pop((key, base), None)
        return self.cas(key, base, value)

    # ---- 对外 CAS ---------------------------------------------------
    def cas(self, key: str, expected: int, value: Any) -> bool:  # type: ignore[override]
        op_id = f"{self.node_id}:{key}:{expected}"
        votes = 1 if self.vote(key, expected, op_id) else 0
        voters = [self.node_id] if votes else []
        for peer in self.peers:
            try:
                resp = httpjson.request_json(
                    f"{peer}/control/cas",
                    {"key": key, "base": expected, "op_id": op_id},
                    timeout=1.5,
                    token=self.token,
                    tls=self.tls,
                )
                if resp.get("granted"):
                    votes += 1
                    voters.append(peer)
            except httpjson.HttpError:
                continue
            if votes >= self.quorum:
                break
        if votes < self.quorum:
            return False
        ok = super().cas(key, expected, value)
        if not ok:
            return False
        for peer in self.peers:
            try:
                httpjson.request_json(
                    f"{peer}/control/commit",
                    {"key": key, "base": expected, "value": value, "op_id": op_id},
                    timeout=1.5,
                    token=self.token,
                    tls=self.tls,
                )
            except httpjson.HttpError:
                continue
        return True

    def sync_from_peers(self) -> int:
        changed = 0
        for peer in self.peers:
            try:
                remote = httpjson.get_json(f"{peer}/control/dump", timeout=1.5, tls=self.tls)
            except httpjson.HttpError:
                continue
            if isinstance(remote, dict):
                changed += self.merge(remote.get("entries", {}))
        return changed


class ControlNode:
    def __init__(
        self,
        node_id: str,
        host: str = "0.0.0.0",
        port: int = 18100,
        peers: list[str] | None = None,
        tls: TLSOptions | None = None,
        token: str | None = None,
        policy: AdmissionPolicy | None = None,
        dispatch_interval: float = 0.3,
        data_dir: str = ".state",
        advertise_url: str | None = None,
    ) -> None:
        self.node_id = node_id
        self.host = host
        self.port = port
        self.tls = tls
        self.token = token
        self.policy = policy or AdmissionPolicy()
        self.dispatch_interval = dispatch_interval
        self.data_dir = Path(data_dir)
        self.peers = [p.rstrip("/") for p in (peers or [])]
        self.advertise_url = advertise_url or f"{'https' if tls else 'http'}://{host}:{port}"
        self.ledger = QuorumLedger(node_id, self.peers, tls, token)
        self._server: httpjson.Server | None = None
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self.dispatch_log: list[dict] = []
        self._url_cache: dict[str, tuple[str, float]] = {}
        self.started_at = time.time()

    # ---------------------------------------------------------- 生命周期
    def start(self) -> "ControlNode":
        self._server = httpjson.Server(self.host, self.port, self.dispatch, name=f"control-{self.node_id}", tls=self.tls)
        self._server.start()
        self.port = self._server.port
        self._spawn(self._router_loop, "router")
        self._spawn(self._sync_loop, "sync")
        return self

    def stop(self) -> None:
        self._stop.set()
        for thread in self._threads:
            thread.join(timeout=3)
        if self._server is not None:
            self._server.stop()

    def _spawn(self, target, name: str) -> None:
        thread = threading.Thread(target=target, name=f"{self.node_id}-{name}", daemon=True)
        thread.start()
        self._threads.append(thread)

    # ---------------------------------------------------------- 注册表
    def register_node(self, payload: dict) -> dict:
        node_id = str(payload.get("node_id") or "")
        ttl = float(payload.get("ttl") or NODE_TTL_DEFAULT)
        record = {
            "node_id": node_id,
            "url": payload.get("url"),
            "urls": payload.get("urls") or ([payload["url"]] if payload.get("url") else []),
            "os": payload.get("os"),
            "cpu_count": payload.get("cpu_count"),
            "max_workers": payload.get("max_workers"),
            "mesh_ip": payload.get("mesh_ip"),
            "caps": payload.get("caps", []),
            "plugin_errors": payload.get("plugin_errors", []),
            "expiry": time.time() + ttl,
            "updated": time.time(),
        }
        self.ledger.put(f"nodes/{node_id}", record)
        return {"ok": True, "node_id": node_id}

    def put_metrics(self, payload: dict) -> dict:
        node_id = str(payload.get("node_id") or "")
        ttl = float(payload.get("ttl") or 12)
        self.ledger.put(f"metrics/{node_id}", {"node_id": node_id, "metrics": payload.get("metrics", {}), "expiry": time.time() + ttl})
        return {"ok": True}

    def nodes(self, alive_only: bool = True) -> list[dict]:
        out = []
        now = time.time()
        for key, entry in self.ledger.dump().items():
            if not key.startswith("nodes/"):
                continue
            record = entry["value"]
            alive = float(record.get("expiry", 0)) > now
            if alive_only and not alive:
                continue
            out.append({**record, "alive": alive})
        return sorted(out, key=lambda r: r.get("node_id", ""))

    def metrics_of(self, node_id: str) -> dict | None:
        entry = self.ledger.get(f"metrics/{node_id}")
        if not entry:
            return None
        record = entry.value
        if float(record.get("expiry", 0)) <= time.time():
            return None
        return record.get("metrics")

    def registry_caps(self, alive_only: bool = True) -> list[Capability]:
        caps: list[Capability] = []
        for node in self.nodes(alive_only=alive_only):
            for raw in node.get("caps", []):
                try:
                    cap = Capability.from_dict(raw)
                except TypeError:
                    continue
                cap.node_id = node.get("node_id", cap.node_id)
                caps.append(cap)
        return dedupe(caps)

    # ---------------------------------------------------------- 任务
    def submit_task(self, task: dict) -> dict:
        task_id = str(task.get("id") or f"t-{uuid.uuid4().hex[:8]}")
        record = {
            "id": task_id,
            "status": "pending",
            "required_caps": task.get("required_caps"),
            "input": task.get("input") or {},
            "timeout": task.get("timeout", 30),
            "created": time.time(),
            "updated": time.time(),
            "node_id": None,
            "worker_id": None,
            "output": None,
            "error": None,
            "reason": None,
            "submitted_by": task.get("submitted_by") or self.node_id,
            "parent": task.get("parent"),
            "result_log": [],
        }
        self.ledger.put(f"tasks/{task_id}", record)
        return {"task_id": task_id, "status": "pending"}

    def task(self, task_id: str) -> dict | None:
        entry = self.ledger.get(f"tasks/{task_id}")
        return entry.value if entry else None

    def tasks(self) -> list[dict]:
        rows = []
        for key, entry in self.ledger.dump().items():
            if key.startswith("tasks/"):
                rows.append(entry["value"])
        return sorted(rows, key=lambda r: r.get("created", 0))

    def set_result(self, task_id: str, payload: dict) -> dict:
        for _ in range(5):  # 乐观重试
            entry = self.ledger.get(f"tasks/{task_id}")
            if not entry:
                return {"ok": False, "error": "no such task"}
            record = dict(entry.value)
            record.update(
                {
                    "status": payload.get("status", "done"),
                    "output": payload.get("output"),
                    "error": payload.get("error"),
                    "node_id": payload.get("node_id") or record.get("node_id"),
                    "worker_id": payload.get("worker_id") or record.get("worker_id"),
                    "elapsed_ms": payload.get("elapsed_ms"),
                    "updated": time.time(),
                }
            )
            record.setdefault("result_log", []).append(
                {"ts": time.time(), "node_id": payload.get("node_id"), "status": record["status"]}
            )
            if self._cas_local(f"tasks/{task_id}", entry.version, record):
                self._release_claim(task_id)
                return {"ok": True, "task": record}
        return {"ok": False, "error": "cas contention"}

    def _claim(self, task_id: str) -> bool:
        base = self.ledger.version(f"claims/{task_id}")
        return self.ledger.cas(f"claims/{task_id}", base, {"router": self.node_id, "ts": time.time(), "expiry": time.time() + CLAIM_TTL})

    def _cas_local(self, key: str, expected: int, value: Any) -> bool:
        """非关键状态（任务结果/状态迁移）只做本地 CAS，再靠 anti-entropy 收敛。

        认领（claims）必须走 quorum；但结果写如果也要求过半数，一旦对端副本短暂不可达，
        任务就会永远卡在 running —— 结果本身是幂等的，用本地 CAS + 版本收敛更合适。
        """
        return Ledger.cas(self.ledger, key, expected, value)

    def _claim_holder(self, task_id: str) -> str | None:
        entry = self.ledger.get(f"claims/{task_id}")
        if not entry:
            return None
        value = entry.value or {}
        if float(value.get("expiry", 0)) <= time.time():
            return None
        return value.get("router")

    def _release_claim(self, task_id: str) -> None:
        base = self.ledger.version(f"claims/{task_id}")
        self._cas_local(f"claims/{task_id}", base, None)

    # ---------------------------------------------------------- 分派
    def pick_node(self, task: dict) -> tuple[dict | None, str]:
        caps = self.registry_caps()
        candidates = [c for c in caps if c.matches(task.get("required_caps"))]
        nodes_with_cap = {c.node_id for c in candidates}
        scored: list[tuple[float, dict]] = []
        reasons: list[str] = []
        for node in self.nodes():
            node_id = node.get("node_id")
            if node_id not in nodes_with_cap:
                continue
            metrics = self.metrics_of(node_id)
            ok, reason = admission_ok(metrics, self.policy)
            if not ok:
                reasons.append(f"{node_id}: {reason}")
                continue
            scored.append((load_score(metrics, self.policy), node))
        if not scored:
            return None, "; ".join(reasons) or "no node has the capability"
        scored.sort(key=lambda item: item[0])
        return scored[0][1], "ok"

    def _node_urls(self, node: dict) -> list[str]:
        urls: list[str] = []
        primary = node.get("url")
        if primary:
            urls.append(primary)
        for url in node.get("urls") or []:
            if url and url not in urls:
                urls.append(url)
        return urls

    def _resolve_node_url(self, node: dict) -> str | None:
        """节点的可达地址可能不止一个（mesh IP / underlay IP / 本地转发）。

        同一节点在不同节点看来可达的地址不同（no-tun 模式下 Windows 到不了 mesh 网段），
        所以这里按顺序探测一次并缓存，避免每次分派都等超时。
        """
        node_id = str(node.get("node_id"))
        urls = self._node_urls(node)
        if not urls:
            return None
        cached = self._url_cache.get(node_id)
        now = time.time()
        if cached and now - cached[1] < 60:
            return cached[0]
        for url in urls:
            try:
                httpjson.get_json(f"{url}/health", timeout=1.5, tls=self.tls)
                self._url_cache[node_id] = (url, now)
                return url
            except httpjson.HttpError:
                continue
        return urls[0]

    def dispatch_once(self) -> list[dict]:
        """扫一遍 pending/queued 任务，能认领就认领并下发。"""
        events: list[dict] = []
        now = time.time()
        for record in self.tasks():
            if record.get("status") not in ("pending", "queued"):
                continue
            # 排队中的任务 5 秒后才重试，避免把 dispatch_log 刷满
            if record.get("status") == "queued" and (now - float(record.get("updated", 0))) < 5.0:
                continue
            task_id = record["id"]
            if self._claim_holder(task_id):
                continue
            if not self._claim(task_id):
                continue
            node, reason = self.pick_node(record)
            if node is None:
                self._release_claim(task_id)
                self._patch_task(task_id, {"status": "queued", "reason": reason, "updated": time.time()})
                events.append({"task": task_id, "event": "queued", "reason": reason})
                continue
            payload = {
                "id": task_id,
                "required_caps": record.get("required_caps"),
                "input": record.get("input"),
                "timeout": record.get("timeout", 30),
            }
            url = self._resolve_node_url(node)
            if not url:
                self._release_claim(task_id)
                self._patch_task(task_id, {"status": "queued", "reason": "node has no reachable url", "updated": time.time()})
                continue
            try:
                resp = httpjson.request_json(f"{url}/tasks", payload, timeout=5, token=self.token, tls=self.tls)
            except httpjson.HttpError as exc:
                self._release_claim(task_id)
                self._patch_task(task_id, {"status": "queued", "reason": f"dispatch failed: {exc}", "updated": time.time()})
                events.append({"task": task_id, "event": "dispatch-failed", "reason": str(exc)})
                continue
            if not resp.get("accepted"):
                self._release_claim(task_id)
                self._patch_task(task_id, {"status": "queued", "reason": resp.get("reason"), "updated": time.time()})
                events.append({"task": task_id, "event": "rejected", "reason": resp.get("reason")})
                continue
            self._patch_task(
                task_id,
                {
                    "status": "running",
                    "node_id": resp.get("node_id") or node.get("node_id"),
                    "worker_id": resp.get("worker_id"),
                    "cap_id": resp.get("cap_id"),
                    "updated": time.time(),
                },
            )
            events.append(
                {
                    "task": task_id,
                    "event": "dispatched",
                    "node": resp.get("node_id"),
                    "worker": resp.get("worker_id"),
                    "cap": resp.get("cap_id"),
                    "router": self.node_id,
                }
            )
        if events:
            self.dispatch_log.extend(events)
            self.dispatch_log = self.dispatch_log[-200:]
            for event in events:
                print(f"[control:{self.node_id}] {event}")
        return events

    def _patch_task(self, task_id: str, patch: dict) -> None:
        for _ in range(5):
            entry = self.ledger.get(f"tasks/{task_id}")
            if not entry:
                return
            record = dict(entry.value)
            record.update(patch)
            if self._cas_local(f"tasks/{task_id}", entry.version, record):
                return

    def _router_loop(self) -> None:
        while not self._stop.wait(self.dispatch_interval):
            try:
                self.dispatch_once()
            except Exception as exc:  # noqa: BLE001
                print(f"[control:{self.node_id}] router error: {type(exc).__name__}: {exc}")

    def _sync_loop(self) -> None:
        while not self._stop.wait(1.0):
            try:
                self.ledger.sync_from_peers()
            except Exception:  # noqa: BLE001
                continue

    # ---------------------------------------------------------- 汇总视图
    def state(self) -> dict:
        caps = self.registry_caps()
        return {
            "router": {
                "node_id": self.node_id,
                "url": self.advertise_url,
                "peers": self.peers,
                "quorum": self.ledger.quorum,
                "uptime_s": round(time.time() - self.started_at, 1),
                "policy": self.policy.to_dict(),
            },
            "nodes": [
                {
                    "node_id": node.get("node_id"),
                    "url": node.get("url"),
                    "os": node.get("os"),
                    "mesh_ip": node.get("mesh_ip"),
                    "alive": node.get("alive"),
                    "caps": len(node.get("caps", [])),
                    "max_workers": node.get("max_workers"),
                    "metrics": self.metrics_of(node.get("node_id")),
                    "plugin_errors": node.get("plugin_errors", []),
                }
                for node in self.nodes()
            ],
            "capabilities": [c.to_dict() for c in caps],
            "tasks": self.tasks()[-50:],
            "dispatch_log": self.dispatch_log[-50:],
            "ts": time.time(),
        }

    def dashboard_html(self) -> bytes:
        path = Path(__file__).parent.parent / "dashboard" / "index.html"
        if path.exists():
            return path.read_bytes()
        return b"<h1>cluster</h1><p>dashboard/index.html missing</p>"

    # ---------------------------------------------------------- HTTP
    def dispatch(self, method: str, path: str, body: Any) -> tuple[int, Any]:
        path = path.split("?")[0]
        if method == "GET" and path in ("/", "/dashboard"):
            return 200, httpjson.Raw(self.dashboard_html())
        if method == "GET" and path == "/control/state":
            return 200, self.state()
        if method == "GET" and path == "/control/health":
            return 200, {"ok": True, "router": self.node_id, "peers": self.peers}
        if method == "GET" and path == "/control/dump":
            return 200, {"entries": self.ledger.dump(), "router": self.node_id}
        if method == "POST" and path == "/control/cas":
            body = body or {}
            granted = self.ledger.vote(str(body.get("key")), int(body.get("base", 0)), str(body.get("op_id")))
            return 200, {"granted": granted, "router": self.node_id}
        if method == "POST" and path == "/control/commit":
            body = body or {}
            ok = self.ledger.commit(str(body.get("key")), int(body.get("base", 0)), body.get("value"))
            return 200, {"ok": ok}
        if method == "POST" and path == "/control/nodes":
            return 200, self.register_node(body or {})
        if method == "POST" and path == "/control/metrics":
            return 200, self.put_metrics(body or {})
        if method == "POST" and path == "/control/tasks":
            return 200, self.submit_task(body or {})
        if method == "GET" and path == "/control/tasks":
            return 200, {"tasks": self.tasks()}
        if path.startswith("/control/tasks/"):
            parts = path.strip("/").split("/")
            task_id = parts[2] if len(parts) > 2 else ""
            if method == "GET" and len(parts) == 3:
                record = self.task(task_id)
                return (200, record) if record else (404, {"error": "not found"})
            if method == "POST" and len(parts) == 4 and parts[3] == "result":
                payload = dict(body or {})
                payload.setdefault("node_id", None)
                return 200, self.set_result(task_id, payload)
        return 404, {"error": f"no route {method} {path}"}
