"""L3：统一能力描述 CapabilityDescriptor + 能力匹配。

MCP / Skill / API 三种插件在 L3 之上全部归一成这一个结构；
L2（控制面）与 L5（编排）只读它，绝不 import 任何插件 SDK。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Iterable

KINDS = ("mcp", "skill", "api")
HEALTH_STATES = ("ready", "degraded", "down")


def _norm(value: Any) -> str:
    return str(value).strip().lower()


@dataclass
class Capability:
    """能力描述符。node_id / endpoint 由 L1 Agent 在注册时补全。"""

    cap_id: str
    kind: str
    name: str
    version: str = "0.1.0"
    description: str = ""
    node_id: str = ""
    endpoint: str = ""
    tool: str = ""  # 适配器内部入口名（MCP tool 名 / skill 名 / api 名），L3 只透传
    input_schema: dict = field(default_factory=dict)
    output_schema: dict = field(default_factory=dict)
    requirements: dict = field(default_factory=dict)
    cost_model: dict = field(default_factory=dict)
    health: dict = field(default_factory=dict)
    tags: list = field(default_factory=list)

    # ---- 序列化 -----------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "cap_id": self.cap_id,
            "kind": self.kind,
            "name": self.name,
            "version": self.version,
            "description": self.description,
            "node_id": self.node_id,
            "endpoint": self.endpoint,
            "tool": self.tool,
            "input_schema": self.input_schema,
            "output_schema": self.output_schema,
            "requirements": self.requirements,
            "cost_model": self.cost_model,
            "health": self.health or {"status": "ready", "last_check": time.time()},
            "tags": self.tags,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Capability":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})

    # ---- 校验 -------------------------------------------------------
    def validate(self) -> list[str]:
        problems: list[str] = []
        if not self.cap_id:
            problems.append("cap_id 不能为空")
        if self.kind not in KINDS:
            problems.append(f"kind 必须是 {KINDS} 之一，实际 {self.kind!r}")
        if not self.name:
            problems.append("name 不能为空")
        schema = self.input_schema
        if schema and not isinstance(schema, dict):
            problems.append("input_schema 必须是 JSON Schema 对象")
        elif schema and schema.get("type") not in (None, "object"):
            problems.append("input_schema.type 目前只支持 object")
        for key in ("est_cpu_ms", "est_mem_mb"):
            value = self.cost_model.get(key)
            if value is not None and (not isinstance(value, (int, float)) or value < 0):
                problems.append(f"cost_model.{key} 必须是非负数")
        status = (self.health or {}).get("status")
        if status is not None and status not in HEALTH_STATES:
            problems.append(f"health.status 必须是 {HEALTH_STATES} 之一")
        return problems

    # ---- 匹配 -------------------------------------------------------
    def matches(self, query: dict | None, env: dict | None = None) -> bool:
        """query 支持：cap_ids/all_of/any_of/kind/name/tags + requirements（os/runtime）。"""
        if (self.health or {}).get("status") == "down":
            return False
        if env is not None and not self.satisfies_env(env):
            return False
        if not query:
            return True
        if query.get("cap_ids") and self.cap_id not in query["cap_ids"]:
            return False
        if query.get("all_of") and not set(query["all_of"]).issubset({self.cap_id, self.name}):
            return False
        if query.get("any_of") and not (set(query["any_of"]) & {self.cap_id, self.name}):
            return False
        if query.get("kind") and _norm(self.kind) != _norm(query["kind"]):
            return False
        if query.get("name") and _norm(self.name) != _norm(query["name"]):
            return False
        if query.get("tags"):
            if not set(query["tags"]).issubset(set(self.tags)):
                return False
        return True

    def satisfies_env(self, env: dict) -> bool:
        """requirements.os / requirements.runtime 必须被目标节点满足。"""
        req = self.requirements or {}
        want_os = [_norm(x) for x in req.get("os", [])]
        if want_os and env.get("os") and _norm(env["os"]) not in want_os:
            return False
        have_runtime = {_norm(x) for x in env.get("runtime", [])}
        want_runtime = [_norm(x) for x in req.get("runtime", [])]
        if want_runtime and have_runtime and not set(want_runtime).issubset(have_runtime):
            return False
        return True

    def load_score(self) -> float:
        """越小越轻。用于同能力多节点时的打分。"""
        cpu = float(self.cost_model.get("est_cpu_ms", 0) or 0)
        mem = float(self.cost_model.get("est_mem_mb", 0) or 0)
        return cpu / 1000.0 + mem / 1024.0


def find(caps: Iterable[Capability], query: dict | None, env: dict | None = None) -> list[Capability]:
    return [cap for cap in caps if cap.matches(query, env)]


def dedupe(caps: Iterable[Capability]) -> list[Capability]:
    """同一 (cap_id, node_id) 只保留一条。"""
    seen: dict[tuple[str, str], Capability] = {}
    for cap in caps:
        seen[(cap.cap_id, cap.node_id)] = cap
    return list(seen.values())


def describe_schema() -> dict:
    """给 CLI / 文档用的字段说明（也用于 capability.schema.json 的一致性）。"""
    return {
        "cap_id": "全局唯一能力 id，建议 {kind}:{name}@{version}",
        "kind": "mcp | skill | api（只用于 L1 本地加载，L3/L5 不关心）",
        "name": "人可读名字",
        "version": "语义版本",
        "description": "一句话说明",
        "node_id": "持有该能力的节点",
        "endpoint": "L1 本地寻址（cap_router 用），L3 只存不解析",
        "tool": "适配器内部入口名",
        "input_schema/output_schema": "JSON Schema",
        "requirements": "{os, runtime, network, permissions}",
        "cost_model": "{est_cpu_ms, est_mem_mb}",
        "health": "{status: ready|degraded|down, last_check}",
        "tags": "自由标签，便于语义查询",
    }
