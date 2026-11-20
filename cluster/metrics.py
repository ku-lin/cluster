"""跨平台资源采样（Windows / Linux / macOS），不依赖 psutil。

对外只暴露 MetricsCollector.sample() -> dict：
  cpu_percent, mem_percent, mem_used_mb, mem_total_mb,
  net_in_rate, net_out_rate, net_unit, cpu_count, os, ts

Windows 的网络计数器来自 iphlpapi!GetIpStatistics（IPv4 报文数），
所以 net_unit = "packets/s"；Linux 读 /proc/net/dev，单位是 "bytes/s"。
准入控制只在 bytes 口径下用带宽阈值，packets 口径只做展示（见 l2_control.admission_ok）。
"""

from __future__ import annotations

import ctypes
import os
import platform
import shutil
import time
from ctypes import wintypes

IS_WINDOWS = os.name == "nt"
OS_TAG = "windows" if IS_WINDOWS else ("linux" if platform.system().lower() == "linux" else platform.system().lower())


class _FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]


class _MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [
        ("dwLength", wintypes.DWORD),
        ("dwMemoryLoad", wintypes.DWORD),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


_IPSTATS_FIELDS = (
    "dwForwarding", "dwDefaultTTL", "dwInReceives", "dwInHdrErrors", "dwInAddrErrors",
    "dwForwDatagrams", "dwInUnknownProtos", "dwInDiscards", "dwInDelivers", "dwOutRequests",
    "dwRoutingDiscards", "dwOutDiscards", "dwOutNoRoutes", "dwReasmTimeout", "dwReasmReqds",
    "dwReasmOks", "dwReasmFails", "dwFragOks", "dwFragFails", "dwFragCreates", "dwNumIf",
    "dwNumAddr", "dwNumRoutes",
)


class _MIB_IPSTATS(ctypes.Structure):
    _fields_ = [(name, wintypes.DWORD) for name in _IPSTATS_FIELDS]


def _filetime_value(ft: "_FILETIME") -> int:
    return (ft.dwHighDateTime << 32) | ft.dwLowDateTime


class MetricsCollector:
    def __init__(self) -> None:
        self._last: dict | None = None
        self._last_ts: float | None = None
        self._cpu_prev: tuple[int, int, int] | None = None
        self._net_prev: tuple[float, float] | None = None
        self.node_os = OS_TAG
        self.cpu_count = os.cpu_count() or 1

    # ---- 各平台原语 -------------------------------------------------
    def _cpu_times(self) -> tuple[int, int, int] | None:
        """返回 (idle, kernel, user) 累计值，单位由平台决定（只用差值）。"""
        if IS_WINDOWS:
            idle, kernel, user = _FILETIME(), _FILETIME(), _FILETIME()
            ok = ctypes.windll.kernel32.GetSystemTimes(
                ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)
            )
            if not ok:
                return None
            return (_filetime_value(idle), _filetime_value(kernel), _filetime_value(user))
        try:
            with open("/proc/stat", "r", encoding="utf-8") as fh:
                line = fh.readline()
            parts = [int(x) for x in line.split()[1:]]
            idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
            total = sum(parts)
            return (idle, total, 0)
        except OSError:
            return None

    def _memory(self) -> tuple[float, float, float]:
        """返回 (mem_percent, used_mb, total_mb)。"""
        if IS_WINDOWS:
            st = _MEMORYSTATUSEX()
            st.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
                total = st.ullTotalPhys / (1024 * 1024)
                used = (st.ullTotalPhys - st.ullAvailPhys) / (1024 * 1024)
                return (float(st.dwMemoryLoad), used, total)
            return (0.0, 0.0, 0.0)
        try:
            info: dict[str, float] = {}
            with open("/proc/meminfo", "r", encoding="utf-8") as fh:
                for line in fh:
                    key, _, rest = line.partition(":")
                    info[key] = float(rest.strip().split()[0])  # kB
            total = info.get("MemTotal", 0.0) / 1024
            avail = info.get("MemAvailable", info.get("MemFree", 0.0)) / 1024
            used = total - avail
            pct = (used / total * 100.0) if total else 0.0
            return (pct, used, total)
        except OSError:
            return (0.0, 0.0, 0.0)

    def _net_counters(self) -> tuple[float, float, str] | None:
        """返回 (in, out, unit)。"""
        if IS_WINDOWS:
            st = _MIB_IPSTATS()
            rc = ctypes.windll.iphlpapi.GetIpStatistics(ctypes.byref(st))
            if rc != 0:
                return None
            return (float(st.dwInReceives), float(st.dwOutRequests), "packets/s")
        try:
            rx = tx = 0.0
            with open("/proc/net/dev", "r", encoding="utf-8") as fh:
                lines = fh.readlines()[2:]
            for line in lines:
                name, _, rest = line.partition(":")
                if name.strip() == "lo":
                    continue
                cols = rest.split()
                rx += float(cols[0])
                tx += float(cols[8])
            return (rx, tx, "bytes/s")
        except (OSError, IndexError, ValueError):
            return None

    # ---- 对外 -------------------------------------------------------
    def sample(self) -> dict:
        now = time.time()
        snapshot: dict = {
            "os": self.node_os,
            "host": platform.node(),
            "cpu_count": self.cpu_count,
            "ts": now,
            "cpu_percent": None,
            "mem_percent": None,
            "mem_used_mb": None,
            "mem_total_mb": None,
            "net_in_rate": None,
            "net_out_rate": None,
            "net_unit": None,
            "workers": 0,
        }

        cpu = self._cpu_times()
        if cpu is not None:
            if self._cpu_prev is not None:
                d_idle = cpu[0] - self._cpu_prev[0]
                d_total = (cpu[1] - self._cpu_prev[1]) + (cpu[2] - self._cpu_prev[2])
                if d_total > 0:
                    snapshot["cpu_percent"] = round(max(0.0, min(100.0, 100.0 * (1 - d_idle / d_total))), 1)
            self._cpu_prev = cpu

        mem_pct, used, total = self._memory()
        snapshot["mem_percent"] = round(mem_pct, 1)
        snapshot["mem_used_mb"] = round(used, 1)
        snapshot["mem_total_mb"] = round(total, 1)

        net = self._net_counters()
        if net is not None:
            unit = net[2]
            snapshot["net_unit"] = unit
            if self._net_prev is not None and self._last_ts is not None:
                dt = max(now - self._last_ts, 1e-3)
                snapshot["net_in_rate"] = round(max(0.0, (net[0] - self._net_prev[0]) / dt), 1)
                snapshot["net_out_rate"] = round(max(0.0, (net[1] - self._net_prev[1]) / dt), 1)
            self._net_prev = (net[0], net[1])

        self._last = snapshot
        self._last_ts = now
        return dict(snapshot)

    @staticmethod
    def disk_free_gb(path: str = ".") -> float:
        try:
            return round(shutil.disk_usage(path).free / (1024 ** 3), 2)
        except OSError:
            return 0.0
