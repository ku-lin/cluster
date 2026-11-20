"""把命令真正脱离当前控制台/作业对象后台启动（Windows）。

用途：scripts/node-win.ps1 用它拉起控制面/Agent，避免 PowerShell 退出或
上层作业（Job Object）被回收时连带杀掉服务。

用法：
    python scripts/start_bg.py <logfile> <command> [args...]
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print("usage: start_bg.py <logfile> <command> [args...]", file=sys.stderr)
        return 2
    log_path = Path(argv[1])
    log_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = argv[2:]
    handle = open(log_path, "ab")
    if os.name == "nt":
        flags = 0
        for name in ("DETACHED_PROCESS", "CREATE_NEW_PROCESS_GROUP", "CREATE_BREAKAWAY_FROM_JOB"):
            flags |= int(getattr(subprocess, name, 0))
        try:
            proc = subprocess.Popen(cmd, stdout=handle, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=flags)
        except OSError:
            # 不允许 breakaway 时退回普通分离进程
            proc = subprocess.Popen(
                cmd,
                stdout=handle,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                creationflags=int(getattr(subprocess, "DETACHED_PROCESS", 0)) | int(getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)),
            )
    else:
        proc = subprocess.Popen(
            cmd, stdout=handle, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True
        )
    print(f"started pid={proc.pid} log={log_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
