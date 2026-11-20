"""Windows 下子进程静默启动：统一给 subprocess 补上"不要弹控制台窗口"的参数。

背景（实测）：L1 Node Agent 是 `scripts/start_bg.py` 用 DETACHED_PROCESS 拉起的，
本身没有控制台。没有控制台的进程每 spawn 一个控制台程序（python.exe /
openssl.exe / easytier-cli.exe），Windows 就会为它新建一个**可见**窗口，
窗口标题就是那个 exe 的全路径。而插件每次 invoke 都要起一个进程，
工作区同步（manifest + 每个文件一次 read/write）就会连着弹出一排窗口。

用法：

    proc = subprocess.run(cmd, capture_output=True, **winproc.hidden_kwargs())
    proc = subprocess.Popen(cmd, **winproc.hidden_kwargs(detached=True))
    # 已经有自定义 creationflags 的调用点，把 flags 直接传进来：
    proc = subprocess.Popen(cmd, **winproc.hidden_kwargs(flags=my_flags))

非 Windows 上返回空 dict，调用点行为与改动前完全一致。
"""

from __future__ import annotations

import os
import subprocess
from typing import Any


def detach_flags() -> int:
    """脱离控制台 + 新进程组：后台常驻进程用（非 Windows 返回 0）。"""
    if os.name != "nt":
        return 0
    return int(getattr(subprocess, "DETACHED_PROCESS", 0)) | int(getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))


def hidden_kwargs(flags: int | None = None, detached: bool = False) -> dict[str, Any]:
    """返回可直接 `**` 展开给 subprocess 的关键字参数，保证 Windows 下不弹窗。

    flags=None 时自动选：detached=True 用 DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP，
    否则用 CREATE_NO_WINDOW（不占用新控制台，stdout/stderr 管道照常工作）。
    显式传 flags 时以调用点为准（例如需要 CREATE_BREAKAWAY_FROM_JOB 的场景）。
    """
    if os.name != "nt":
        return {}

    if flags is None:
        flags = detach_flags() if detached else int(getattr(subprocess, "CREATE_NO_WINDOW", 0))

    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = subprocess.SW_HIDE
    return {"creationflags": flags, "startupinfo": startupinfo}
