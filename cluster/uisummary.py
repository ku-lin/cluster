"""L6 前端用的纯函数：把控制面状态压成"首屏能一眼看完"的形状。

单独成模块只为一件事：**可测**。网关本身要连控制面（mTLS），但下面这些函数
全是纯数据变换，单测里塞几个 dict 就能验证，不必起进程、不必发请求。

三块：
    queue_summary(tasks)              任务队列分桶（等待 / 运行中 / 完成 / 失败 / 取消）
    push_point / history_of           每节点 CPU/内存采样环形缓冲（趋势图数据）
    workspace_summary(record, runs)   工作区 + 它最近一轮同步的浓缩状态（状态/冲突/失败）
"""

from __future__ import annotations

import time
from typing import Any, Iterable

# 队列桶的展示顺序：从"正在积压"到"已经结束"。
QUEUE_BUCKETS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("waiting", ("pending", "queued")),
    ("running", ("claimed", "running")),
    ("done", ("done",)),
    ("failed", ("failed",)),
    ("cancelled", ("cancelled",)),
)


def queue_summary(tasks: Iterable[dict] | None) -> dict[str, Any]:
    """按状态把任务分桶。

    返回 {"counts": {bucket: n}, "total": n, "waiting": n, "running": n, ...}。
    未知状态记到 unknown，不丢样本——否则页面上"总数"会和分桶加起来对不上。
    """
    counts = {name: 0 for name, _ in QUEUE_BUCKETS}
    counts["unknown"] = 0
    total = 0
    for task in tasks or []:
        if not isinstance(task, dict):
            continue
        total += 1
        status = str(task.get("status") or "").lower()
        for name, statuses in QUEUE_BUCKETS:
            if status in statuses:
                counts[name] += 1
                break
        else:
            counts["unknown"] += 1
    return {"counts": counts, "total": total}


def push_point(history: dict[str, list[dict]], node_id: str, point: dict, limit: int = 120) -> None:
    """往环形缓冲里追加一个采样点（同一时间戳只留一个）。

    采样线程和 /api/hosts 都会调，所以这里要幂等：ts 相同就覆盖而不是叠加。
    """
    if not node_id:
        return
    ts = float(point.get("ts") or 0)
    if ts <= 0:
        ts = time.time()
    row = {"ts": round(ts, 3)}
    for key in ("cpu", "mem", "workers", "agents"):
        value = point.get(key)
        if isinstance(value, (int, float)):
            row[key] = value
    series = history.setdefault(node_id, [])
    if series and abs(float(series[-1].get("ts") or 0) - row["ts"]) < 1e-6:
        series[-1] = row
    else:
        series.append(row)
    if len(series) > limit:
        del series[: len(series) - limit]


def history_of(history: dict[str, list[dict]], node_id: str, limit: int = 40) -> list[dict]:
    series = history.get(node_id) or []
    return series[-limit:] if limit else series


def _run_digest(run: dict | None) -> dict | None:
    if not run:
        return None
    counts = run.get("counts") or {}
    return {
        "id": run.get("id"),
        "status": run.get("status"),
        "policy": run.get("policy"),
        "attempt": run.get("attempt", 1),
        "created": run.get("created"),
        "finished": run.get("finished"),
        "counts": {
            "files": int(counts.get("files") or 0),
            "in_sync": int(counts.get("in_sync") or 0),
            "copied": int(counts.get("copied") or 0),
            "conflicts": int(counts.get("conflicts") or 0),
            "failed": int(counts.get("failed") or 0),
        },
        "nodes": [
            {
                "node_id": row.get("node_id"),
                "status": row.get("status"),
                "written": row.get("written"),
                "manifest_files": row.get("manifest_files"),
                "errors": (row.get("errors") or [])[:2],
            }
            for row in (run.get("nodes") or {}).values()
        ],
        "error": run.get("error"),
    }


def workspace_summary(record: dict, runs: dict[str, dict] | None) -> dict:
    """工作区记录 + 最近一轮同步的浓缩状态。

    面板的"同步"行只看这个：last.status（done/partial/failed/running）+ 冲突数 + 失败数。
    """
    runs = runs or {}
    last = _run_digest(runs.get(record.get("last_run") or ""))
    return {
        "name": record.get("name"),
        "policy": record.get("policy"),
        "created": record.get("created"),
        "last_status": record.get("last_status") or (last or {}).get("status"),
        "last_run": record.get("last_run"),
        "last": last,
    }
