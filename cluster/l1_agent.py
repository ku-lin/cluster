"""L1 Node Agent：指标采集、能力扫描/注册、worker 生命周期、本地 cap_router。

四件事（对应设计里的 ①②③④）：
  ① 指标采集器     -> 推到 L2 指标通道（control 的 /control/metrics）
  ② 能力管理器     -> 扫描 plugins/，把 CapabilityDescriptor 注册到 L3
  ③ Worker 管理器  -> 按准入拉起/回收 worker（线程级隔离；容器化见 README 路线）
  ④ 本地 cap_router-> cap_id -> adapter 寻址（同一进程内 + /invoke 远端入口）
"""

from __future__ import annotations

import json
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Any

from . import httpjson, l0_network
from .httpjson import TLSOptions
from .l3_capability import Capability
from .l4_adapters import Adapter, load_plugins
from .metrics import MetricsCollector
from .policy import AdmissionPolicy, admission_ok


class Worker:
    def __init__(self, task_id: str, worker_id: str | None = None) -> None:
        self.worker_id = worker_id or f"w-{uuid.uuid4().hex[:8]}"
        self.task_id = task_id
        self.status = "starting"
        self.started_at = time.time()
        self.ended_at: float | None = None
        self.cap_id: str | None = None
        self.error: str | None = None

    def to_dict(self) -> dict:
        return {
            "worker_id": self.worker_id,
            "task_id": self.task_id,
            "status": self.status,
            "cap_id": self.cap_id,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "elapsed_s": round((self.ended_at or time.time()) - self.started_at, 3),
            "error": self.error,
        }


class Agent:
    def __init__(
        self,
        node_id: str,
        host: str = "0.0.0.0",
        port: int = 17100,
        control_urls: list[str] | None = None,
        plugins_dir: str | Path | list[str] = "examples/plugins",
        tls: TLSOptions | None = None,
        token: str | None = None,
        policy: AdmissionPolicy | None = None,
        metrics_interval: float = 2.0,
        heartbeat_interval: float = 5.0,
        mesh_ip: str | None = None,
        data_dir: str = ".state",
        extra_urls: list[str] | None = None,
    ) -> None:
        self.node_id = node_id
        self.host = host
        self.port = port
        self.control_urls = [u.rstrip("/") for u in (control_urls or [])]
        self.plugins_dir = plugins_dir
        self.tls = tls
        self.token = token
        self.policy = policy or AdmissionPolicy()
        self.metrics_interval = metrics_interval
        self.heartbeat_interval = heartbeat_interval
        self.mesh_ip = mesh_ip
        self.extra_urls = [u.rstrip("/") for u in (extra_urls or [])]
        self.data_dir = Path(data_dir)

        self.collector = MetricsCollector()
        self.metrics: dict = {}
        self.adapters: list[Adapter] = []
        self.caps: list[Capability] = []
        self.plugin_errors: list[str] = []
        self.workers: dict[str, Worker] = {}
        self._workers_lock = threading.Lock()
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._server: httpjson.Server | None = None
        self.started_at = time.time()

    # ---------------------------------------------------------- 生命周期
    @property
    def url(self) -> str:
        scheme = "https" if self.tls else "http"
        return f"{scheme}://{self.host}:{self.port}"

    def advertise_urls(self) -> list[str]:
        primary = [self.advertise_url()]
        for url in self.extra_urls:
            if url not in primary:
                primary.append(url)
        return primary

    def advertise_url(self) -> str:
        """注册到控制面的地址：优先 mesh IP（同行可达），否则用 host。"""
        scheme = "https" if self.tls else "http"
        host = self.mesh_ip or self.host
        return f"{scheme}://{host}:{self.port}"

    def start(self) -> "Agent":
        self._load_plugins()
        self.metrics = self._sample()  # 先采样一次，让第二个样本能算出速率
        self._server = httpjson.Server(self.host, self.port, self.dispatch, name=f"agent-{self.node_id}", tls=self.tls)
        self._server.start()
        self.port = self._server.port
        self._spawn(self._metrics_loop, "metrics")
        self._spawn(self._heartbeat_loop, "heartbeat")
        self._register(initial=True)
        return self

    def stop(self) -> None:
        self._stop.set()
        for thread in self._threads:
            thread.join(timeout=3)
        if self._server is not None:
            self._server.stop()
        for adapter in self.adapters:
            adapter.close()

    def _spawn(self, target, name: str) -> None:
        thread = threading.Thread(target=target, name=f"{self.node_id}-{name}", daemon=True)
        thread.start()
        self._threads.append(thread)

    # ---------------------------------------------------------- 插件 / 能力
    def _load_plugins(self) -> None:
        roots = [self.plugins_dir] if isinstance(self.plugins_dir, (str, Path)) else list(self.plugins_dir)
        self.adapters = []
        self.plugin_errors = []
        for root in roots:
            adapters, errors = load_plugins(root)
            self.adapters.extend(adapters)
            self.plugin_errors.extend(errors)
        env = {"os": self.collector.node_os, "runtime": [f"python{sys_version()}"], "node_id": self.node_id}
        caps: list[Capability] = []
        for adapter in self.adapters:
            try:
                for cap in adapter.describe():
                    cap.node_id = self.node_id
                    cap.endpoint = f"agent://{self.node_id}/{cap.cap_id}"
                    problems = cap.validate()
                    if problems:
                        self.plugin_errors.append(f"{cap.cap_id}: {'; '.join(problems)}")
                        continue
                    if not cap.satisfies_env(env):
                        continue
                    caps.append(cap)
            except Exception as exc:  # noqa: BLE001 - 单个插件坏了不能拖垮 Agent
                self.plugin_errors.append(f"{adapter.name}: {type(exc).__name__}: {exc}")
        self.caps = caps

    def find_cap(self, query: dict | None) -> Capability | None:
        env = {"os": self.collector.node_os, "runtime": [f"python{sys_version()}"]}
        for cap in self.caps:
            if cap.matches(query, env):
                return cap
        return None

    def _adapter_for(self, cap: Capability) -> Adapter | None:
        for adapter in self.adapters:
            if adapter.kind == cap.kind and adapter.name == cap.name.split("/")[0]:
                return adapter
        return None

    def invoke_local(self, cap_id: str, args: dict, timeout: float = 30.0) -> dict:
        cap = next((c for c in self.caps if c.cap_id == cap_id), None)
        if cap is None:
            return {"ok": False, "output": None, "error": f"no such capability: {cap_id}", "elapsed_ms": 0}
        adapter = self._adapter_for(cap)
        if adapter is None:
            return {"ok": False, "output": None, "error": f"adapter missing for {cap_id}", "elapsed_ms": 0}
        return adapter.invoke(cap.tool, args, timeout)

    # ---------------------------------------------------------- 指标 / 心跳
    def _sample(self) -> dict:
        metrics = self.collector.sample()
        with self._workers_lock:
            active = sum(1 for w in self.workers.values() if w.status in ("starting", "running"))
        metrics.update(
            {
                "node_id": self.node_id,
                "workers": active,
                "max_workers": self.policy.max_workers,
                "mesh_ip": self.mesh_ip,
                "uptime_s": round(time.time() - self.started_at, 1),
            }
        )
        return metrics

    def _metrics_loop(self) -> None:
        while not self._stop.wait(self.metrics_interval):
            try:
                self.metrics = self._sample()
                self._push_metrics()
            except Exception:  # noqa: BLE001
                traceback.print_exc()

    def _heartbeat_loop(self) -> None:
        while not self._stop.wait(self.heartbeat_interval):
            try:
                self._register()
            except Exception:  # noqa: BLE001
                traceback.print_exc()

    def _register(self, initial: bool = False) -> None:
        payload = {
            "node_id": self.node_id,
            "url": self.advertise_url(),
            "urls": self.advertise_urls(),
            "os": self.collector.node_os,
            "host": self.collector.cpu_count,
            "cpu_count": self.collector.cpu_count,
            "max_workers": self.policy.max_workers,
            "mesh_ip": self.mesh_ip,
            "caps": [cap.to_dict() for cap in self.caps],
            "plugin_errors": self.plugin_errors,
            "ttl": max(self.heartbeat_interval * 3, 15),
        }
        for control in self.control_urls:
            try:
                httpjson.request_json(f"{control}/control/nodes", payload, timeout=5, token=self.token, tls=self.tls)
                if initial:
                    print(f"[{self.node_id}] registered to {control} with {len(self.caps)} caps")
            except httpjson.HttpError as exc:
                if initial:
                    print(f"[{self.node_id}] register to {control} failed: {exc}")

    def _push_metrics(self) -> None:
        payload = {"node_id": self.node_id, "metrics": self.metrics, "ttl": max(self.metrics_interval * 4, 12)}
        for control in self.control_urls:
            try:
                httpjson.request_json(f"{control}/control/metrics", payload, timeout=4, token=self.token, tls=self.tls)
            except httpjson.HttpError:
                continue

    def _report_result(self, task_id: str, result: dict) -> None:
        payload = {"node_id": self.node_id, **result}
        for control in self.control_urls:
            try:
                resp = httpjson.request_json(
                    f"{control}/control/tasks/{task_id}/result", payload, timeout=6, token=self.token, tls=self.tls
                )
                if resp.get("ok"):
                    return
                print(f"[{self.node_id}] report {task_id} -> {control}: {resp.get('error')}", flush=True)
            except httpjson.HttpError as exc:
                print(f"[{self.node_id}] report {task_id} -> {control} failed: {exc}", flush=True)

    # ---------------------------------------------------------- 任务执行
    def submit_task(self, task: dict) -> dict:
        """Router 调用入口：本地二次准入 + 拉起一个 worker。"""
        ok, reason = admission_ok(self.metrics, self.policy)
        if not ok:
            return {"accepted": False, "reason": f"local admission: {reason}", "node_id": self.node_id}
        task_id = str(task.get("id") or f"t-{uuid.uuid4().hex[:8]}")
        cap = self.find_cap(task.get("required_caps"))
        if cap is None:
            return {"accepted": False, "reason": f"no capability matches {task.get('required_caps')}", "node_id": self.node_id}
        worker = Worker(task_id)
        worker.cap_id = cap.cap_id
        worker.status = "running"
        with self._workers_lock:
            self.workers[worker.worker_id] = worker
        thread = threading.Thread(
            target=self._run_task,
            args=(worker, cap, task),
            name=f"worker-{worker.worker_id}",
            daemon=True,
        )
        thread.start()
        return {"accepted": True, "worker_id": worker.worker_id, "cap_id": cap.cap_id, "node_id": self.node_id}

    def _run_task(self, worker: Worker, cap: Capability, task: dict) -> None:
        timeout = float(task.get("timeout", 30))
        started = time.time()
        try:
            adapter = self._adapter_for(cap)
            if adapter is None:
                raise RuntimeError(f"adapter missing for {cap.cap_id}")
            result = adapter.invoke(cap.tool, task.get("input") or {}, timeout)
            status = "done" if result.get("ok") else "failed"
            payload = {
                "status": status,
                "task_id": worker.task_id,
                "worker_id": worker.worker_id,
                "cap_id": cap.cap_id,
                "output": result.get("output"),
                "error": result.get("error"),
                "elapsed_ms": round((time.time() - started) * 1000, 1),
            }
        except Exception as exc:  # noqa: BLE001
            status = "failed"
            payload = {
                "status": status,
                "task_id": worker.task_id,
                "worker_id": worker.worker_id,
                "cap_id": cap.cap_id,
                "output": None,
                "error": f"{type(exc).__name__}: {exc}",
                "elapsed_ms": round((time.time() - started) * 1000, 1),
            }
        worker.status = "done" if status == "done" else "failed"
        worker.ended_at = time.time()
        worker.error = payload.get("error")
        self._report_result(worker.task_id, payload)

    # ---------------------------------------------------------- HTTP
    def dispatch(self, method: str, path: str, body: Any) -> tuple[int, Any]:
        path = path.split("?")[0]
        if method == "GET" and path in ("/health", "/"):
            return 200, {
                "node_id": self.node_id,
                "status": "ok",
                "os": self.collector.node_os,
                "mesh_ip": self.mesh_ip,
                "caps": len(self.caps),
                "workers": len(self.workers),
                "uptime_s": round(time.time() - self.started_at, 1),
            }
        if method == "GET" and path == "/metrics":
            return 200, {"node_id": self.node_id, "metrics": self.metrics, "policy": self.policy.to_dict()}
        if method == "GET" and path == "/caps":
            return 200, {"node_id": self.node_id, "caps": [c.to_dict() for c in self.caps], "errors": self.plugin_errors}
        if method == "GET" and path == "/workers":
            with self._workers_lock:
                return 200, {"node_id": self.node_id, "workers": [w.to_dict() for w in self.workers.values()]}
        if method == "POST" and path == "/invoke":
            body = body or {}
            return 200, self.invoke_local(str(body.get("cap_id", "")), body.get("args") or {}, float(body.get("timeout", 30)))
        if method == "POST" and path == "/tasks":
            return 200, self.submit_task(body or {})
        if method == "PUT" and path == "/plugins/reload":
            self._load_plugins()
            return 200, {"caps": len(self.caps), "errors": self.plugin_errors}
        return 404, {"error": f"no route {method} {path}"}

    # ---------------------------------------------------------- 证据
    def state(self) -> dict:
        return {
            "node_id": self.node_id,
            "url": self.advertise_url(),
            "urls": self.advertise_urls(),
            "os": self.collector.node_os,
            "mesh_ip": self.mesh_ip,
            "metrics": self.metrics,
            "policy": self.policy.to_dict(),
            "caps": [c.to_dict() for c in self.caps],
            "plugin_errors": self.plugin_errors,
            "workers": [w.to_dict() for w in self.workers.values()],
        }


def sys_version() -> str:
    import sys

    return f"{sys.version_info.major}.{sys.version_info.minor}"


def main(argv: list[str] | None = None) -> int:  # 便于 `python -m cluster.l1_agent`
    from .cli import main as cli_main

    return cli_main(["agent", *(argv or [])])
