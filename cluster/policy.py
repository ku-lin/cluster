"""准入控制策略（L2 分派前一次、L1 执行前再校验一次的同一套规则）。"""

from __future__ import annotations

from dataclasses import dataclass

DEFAULTS = {
    "cpu_percent_max": 92.0,
    "mem_percent_max": 92.0,
    "net_bytes_per_sec_max": 0,  # 0 = 不限制（packets/s 口径下不参与判断）
    "max_workers": 4,
}


@dataclass
class AdmissionPolicy:
    cpu_percent_max: float = DEFAULTS["cpu_percent_max"]
    mem_percent_max: float = DEFAULTS["mem_percent_max"]
    net_bytes_per_sec_max: int = 0
    max_workers: int = DEFAULTS["max_workers"]

    @classmethod
    def from_dict(cls, data: dict | None) -> "AdmissionPolicy":
        data = data or {}
        return cls(
            cpu_percent_max=float(data.get("cpu_percent_max", DEFAULTS["cpu_percent_max"])),
            mem_percent_max=float(data.get("mem_percent_max", DEFAULTS["mem_percent_max"])),
            net_bytes_per_sec_max=int(data.get("net_bytes_per_sec_max", 0) or 0),
            max_workers=int(data.get("max_workers", DEFAULTS["max_workers"])),
        )

    def to_dict(self) -> dict:
        return {
            "cpu_percent_max": self.cpu_percent_max,
            "mem_percent_max": self.mem_percent_max,
            "net_bytes_per_sec_max": self.net_bytes_per_sec_max,
            "max_workers": self.max_workers,
        }


def admission_ok(metrics: dict | None, policy: AdmissionPolicy, headroom: float = 0.0) -> tuple[bool, str]:
    """返回 (是否可接新活, 原因)。metrics 缺失时视为未知 -> 不拦（fail-open 但记账）。

    headroom：给"开新子智能体"留的余量，0.2 表示要求比阈值再多 20% 空闲。
    """
    if not metrics:
        return True, "no-metrics"
    cpu = metrics.get("cpu_percent")
    mem = metrics.get("mem_percent")
    workers = int(metrics.get("workers") or 0)

    if workers >= policy.max_workers:
        return False, f"workers {workers}/{policy.max_workers} 已满"
    if cpu is not None:
        limit = policy.cpu_percent_max * (1 - headroom)
        if float(cpu) >= limit:
            return False, f"cpu {cpu}% >= {limit:.0f}%"
    if mem is not None:
        limit = policy.mem_percent_max * (1 - headroom)
        if float(mem) >= limit:
            return False, f"mem {mem}% >= {limit:.0f}%"
    if policy.net_bytes_per_sec_max and metrics.get("net_unit") == "bytes/s":
        rate = max(float(metrics.get("net_in_rate") or 0), float(metrics.get("net_out_rate") or 0))
        if rate >= policy.net_bytes_per_sec_max:
            return False, f"net {rate:.0f}B/s >= {policy.net_bytes_per_sec_max}B/s"
    return True, "ok"


def load_score(metrics: dict | None, policy: AdmissionPolicy) -> float:
    """节点打分：负载越低越优先（0~1，越小越好）。"""
    if not metrics:
        return 1.0
    cpu = float(metrics.get("cpu_percent") or 0) / max(policy.cpu_percent_max, 1.0)
    mem = float(metrics.get("mem_percent") or 0) / max(policy.mem_percent_max, 1.0)
    workers = float(metrics.get("workers") or 0) / max(policy.max_workers, 1)
    return round(cpu * 0.4 + mem * 0.4 + workers * 0.2, 4)
