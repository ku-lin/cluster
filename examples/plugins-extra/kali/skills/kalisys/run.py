"""返回本机系统信息（用于证明任务真的在某一台机器上执行）。"""

import json
import platform
import socket
import time


def main() -> int:
    info = {
        "host": socket.gethostname(),
        "os": platform.system(),
        "release": platform.release(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "pid": __import__("os").getpid(),
        "ts": time.time(),
    }
    print(json.dumps(info, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
