"""L5 编排层：提交任务、盯状态、按实时容量决定是否开新子智能体。

子智能体 = 一个任务 + 一组 cap 依赖 + 资源配额；它不关心 cap 在 Windows 还是 Kali，
也不关心是 MCP、Skill 还是 API。
"""

from __future__ import annotations

import time

from . import httpjson
from .httpjson import TLSOptions
from .policy import AdmissionPolicy, admission_ok


class Orchestrator:
    def __init__(self, control_url: str, tls: TLSOptions | None = None, token: str | None = None) -> None:
        self.control = control_url.rstrip("/")
        self.tls = tls
        self.token = token

    # ---- 基础查询 ---------------------------------------------------
    def state(self) -> dict:
        return httpjson.get_json(f"{self.control}/control/state", timeout=10, tls=self.tls)

    def submit(self, required_caps: dict, payload: dict | None = None, timeout: float = 30, parent: str | None = None) -> dict:
        body = {
            "required_caps": required_caps,
            "input": payload or {},
            "timeout": timeout,
            "parent": parent,
            "submitted_by": "orchestrator",
        }
        return httpjson.request_json(f"{self.control}/control/tasks", body, timeout=10, token=self.token, tls=self.tls)

    def task(self, task_id: str) -> dict:
        return httpjson.get_json(f"{self.control}/control/tasks/{task_id}", timeout=10, tls=self.tls)

    def wait(self, task_id: str, timeout: float = 60.0, interval: float = 0.3) -> dict:
        deadline = time.time() + timeout
        last: dict = {}
        while time.time() < deadline:
            last = self.task(task_id)
            if last.get("status") in ("done", "failed", "cancelled"):
                return last
            time.sleep(interval)
        return last

    # ---- 容量判断 ---------------------------------------------------
    def capacity(self, required_caps: dict, headroom: float = 0.2) -> dict:
        state = self.state()
        policy = AdmissionPolicy.from_dict(state["router"].get("policy"))
        caps = [c for c in state["capabilities"] if _matches(c, required_caps)]
        nodes = {c["node_id"] for c in caps}
        ready = []
        blocked = []
        for node in state["nodes"]:
            if node["node_id"] not in nodes:
                continue
            ok, reason = admission_ok(node.get("metrics"), policy, headroom=headroom)
            (ready if ok else blocked).append({"node_id": node["node_id"], "reason": reason, "metrics": node.get("metrics")})
        return {"ready": ready, "blocked": blocked, "nodes_with_cap": sorted(nodes), "policy": policy.to_dict()}

    def maybe_spawn_subagent(
        self,
        required_caps: dict,
        payload: dict | None = None,
        headroom: float = 0.2,
        min_nodes: int = 1,
        parent: str | None = None,
    ) -> dict:
        """观测状态 -> 有容量就开子智能体（真正提交任务），否则 defer 并说明原因。"""
        capacity = self.capacity(required_caps, headroom=headroom)
        if len(capacity["ready"]) < min_nodes:
            return {
                "spawned": False,
                "reason": "insufficient_capacity",
                "detail": capacity,
            }
        submitted = self.submit(required_caps, payload, parent=parent)
        return {"spawned": True, "task": submitted, "capacity": capacity}


def _matches(cap: dict, query: dict | None) -> bool:
    from .l3_capability import Capability

    try:
        return Capability.from_dict(cap).matches(query)
    except TypeError:
        return False
