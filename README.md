# cluster — 分布式多机 Agent 集群

把多台机器（Windows + Kali/Linux）连成一个集群：**网络层用 EasyTier 组网，控制面用多副本 Router 去中心化调度，能力层把 MCP / Skill / API 统一成一种描述，编排层按实时指标决定能不能开新的子智能体。**

这不是一个"多机终端"玩具：节点注册、能力注册、任务认领、准入控制、指标采集、mTLS 双向认证都是真的在跑，两台机器之间是真的在互相调任务。

**当前版本 `v1.0.0`**：core（L0–L5 + L6 工作区同步/UI 网关）与 DeepSeek Harness 插件 `dsh-cluster-ui 1.0.0` 一并首发，变更见 [CHANGELOG.md](CHANGELOG.md)，发布见 [Releases](https://github.com/ku-lin/cluster/releases)。

```
┌─────────────────────────────────────────────────────────┐
│ L5 编排   Orchestrator / 子智能体准入                     │  只读 Capacity，不认插件类型
├─────────────────────────────────────────────────────────┤
│ L4 插件   MCP Adapter │ Skill Adapter │ API Adapter       │  统一 Invoke
├─────────────────────────────────────────────────────────┤
│ L3 能力   CapabilityDescriptor + Registry                │  注册/发现/匹配
├─────────────────────────────────────────────────────────┤
│ L2 控制   Router(多副本) + CAS 认领 + 准入 + 指标         │  认领/分派
├─────────────────────────────────────────────────────────┤
│ L1 节点   Node Agent（指标/能力/worker/cap_router）       │  采集/上报/执行
├─────────────────────────────────────────────────────────┤
│ L0 网络   EasyTier mesh（局域网直连 + 中继兜底）           │  只提供 IP 可达性
└─────────────────────────────────────────────────────────┘
```

## 30 秒跑起来（单机，不需要 EasyTier）

```bash
python -m cluster selfcheck          # 9 项内置断言：CAS/准入/mTLS/端到端
python -m unittest discover -s tests # 37 个单元与集成测试
python -m cluster demo               # 起 1 控制面 + 1 Agent，跑一个真实任务
```

只用标准库，Python ≥ 3.10（本机 3.13 验证；无第三方依赖，故无 lockfile）。mTLS 需要 `openssl` 在 PATH。

## 两机集群（Windows + Kali，实测跑通）

```powershell
# Windows 侧
python -m cluster net fetch                    # 下载 EasyTier v2.6.4 到 .cache/
python -m cluster certs init                   # 自签 CA
python -m cluster certs issue --name win  --san IP:10.14.14.1 --san IP:192.168.70.1 ...
powershell -File scripts\l0-win.ps1            # 组网 + 落盘 peer 状态
powershell -File scripts\node-win.ps1          # 控制面副本 18100 + Agent 17100
```

```bash
# Kali 侧（目录 ~/cluster-test/cluster-app，只碰这个目录）
python3 -m cluster certs issue --name kali --san IP:10.14.14.2 --san IP:192.168.70.145 ...
sudo bash scripts/l0-kali.sh                   # root 建 TUN 加入 mesh
bash scripts/node-kali.sh                      # 控制面副本 18101 + Agent 17100
```

两边都起来后：

```bash
python -m cluster status --control https://127.0.0.1:18100 --tls-dir .state/tls --cert-name win
# nodes: kali-node(linux) + win-node(windows)，各 5 个能力，带实时 cpu/mem/net
python -m cluster submit --control https://127.0.0.1:18100 --tls-dir .state/tls --cert-name win \
  --caps-file .state/cap-kali.json --input-file .state/in-1.json --wait 20
```

## 实测证据（本机 Windows 物理机 + VMware Kali VM）

| 项目 | 结果 |
|---|---|
| EasyTier peer | `10.14.14.1 ↔ 10.14.14.2`，`cost=p2p`，`lat 0.38ms`，`loss 0%`，`tunnel=tcp`，route `path_len=1 DIRECT` |
| NAT | 两端 `PortRestricted`，UDP STUN 正常（Kali 公网出口 183.195.9.138） |
| 节点注册 | 2 个节点、10 个能力（每端 5：mcp×2 + skill×2 + api×1） |
| 跨机任务 A（Kali 专属能力） | `t-565dc415` → `kali-node`，输出 `host=kali`，24.3ms |
| 跨机任务 B（Windows 专属能力） | `t-94760f50` → `win-node`，输出 `host=DESKTOP-PD3AE9A`，336.6ms |
| 跨机任务 C（通用能力，任选节点） | `t-1548a8dc` → `kali-node`，`upper=HELLO FROM WINDOWS`，18.5ms |
| 双副本都在干活 | win-router 分派 7 个任务；kali-router 分派 `t-0c276824` → win-node |
| mTLS | 无客户端证书连 `https://…/control/health` 被拒；两端证书 `openssl verify` OK |

原始证据在 `.state/evidence/`（`net-win.json`、`net-kali.json`、`state-win.json`、`task-*.json`、`control-*.log`）。

## 核心设计

### L3：一种能力描述，三种插件

MCP / Skill / API 在上层眼里没有区别，只有 `CapabilityDescriptor`：

```json
{
  "cap_id": "skill:upper@1.0.0",
  "kind": "mcp | skill | api",        // 只有 L1 本地加载时关心
  "name": "upper", "version": "1.0.0",
  "node_id": "win-node",
  "tool": "upper",                   // 适配器内部入口
  "input_schema": {"type": "object"},
  "requirements": {"os": ["windows", "linux"]},
  "cost_model": {"est_cpu_ms": 20, "est_mem_mb": 32},
  "health": {"status": "ready"},
  "endpoint": "agent://win-node/skill:upper@1.0.0"
}
```

L2 分派时只做 `cap.matches(query)` + `cap.satisfies_env(node_env)`，绝不 import 任何插件 SDK。新增一种插件类型 = 写一个 Adapter + 注册，L2/L5 一行不改。

### L4：三种 Adapter，同一调用协议

| Adapter | 输入 | 调用方式 | 生命周期 |
|---|---|---|---|
| `mcp` | stdio 启动的 MCP server | 行分隔 JSON-RPC：`initialize` → `tools/list` → `tools/call` | Agent 拉起子进程，随 Agent 关闭 |
| `skill` | 目录 + `skill.yaml` | 子进程，JSON 从 stdin 进、一行 JSON 从 stdout 出 | 每次调用起进程（隔离，慢一点） |
| `api` | yaml/json 里的 URL 模板 | 直接 HTTP 转发 | 无进程 |

### L2：控制面去中心化（active-active，不是单点）

- **每个节点都跑同一个 `ControlNode`**，物理对等，没有"中心机"；`Router` 是一个角色，不是一台机器。
- **任务认领走 quorum CAS**：先向所有副本投票（每个副本对同一 `(key, version)` 只投一次），过半才提交。两个 Router 并发抢同一个任务时，物理上只可能有一个赢。
- **状态复制**：带版本的 KV，后台 anti-entropy 每秒拉对端 `dump` 合并；任务进入终态后不允许被对端的 `running` 覆盖。
- **状态写分两档**：认领必须过半数（正确性）；任务结果/状态迁移只做本地 CAS + 收敛（幂等，避免对端短暂不可达就把任务卡死在 running）。
- 没有 leader 选举：日常分派靠 CAS 并发，全局清理每个副本各自幂等做。

### L2/L1：准入控制（同一套规则，两处校验）

```python
admission_ok(metrics, policy, headroom)  # cpu_percent_max / mem_percent_max / max_workers
```

Router 分派前查一次全局指标；Node Agent 执行前再查一次本地实时指标（防止分派到执行之间的漂移）。指标不够就 `queued` 并写明原因，不硬塞。

### L1：指标采集（无 psutil）

| 平台 | CPU | 内存 | 网络 |
|---|---|---|---|
| Windows | `GetSystemTimes` 差分 | `GlobalMemoryStatusEx` | `iphlpapi!GetIpStatistics`（**报文/s**） |
| Linux | `/proc/stat` | `/proc/meminfo` | `/proc/net/dev`（**字节/s**） |

口径不同这件事写在字段里（`net_unit`），准入只在 `bytes/s` 口径下用带宽阈值。

### L5：按实时容量开子智能体

```python
orch.maybe_spawn_subagent({"cap_ids": ["skill:upper@1.0.0"]}, {"text": "hi"}, headroom=0.2)
# -> {"spawned": True, "task": {...}} 或 {"spawned": False, "reason": "insufficient_capacity", "detail": {...}}
```

`headroom=0.2` 表示要求比阈值再多 20% 空闲；容量查询基于所有节点的实时指标 + 能力匹配。

### L6：工作区同步（每台机器一个目录，内容保持一致）

集群里"共享工作区"的最小可用实现：**节点侧无状态，合并与重试全在网关侧**。

- 节点侧能力 `skill:ws@1.0.0`（`examples/plugins/skills/ws/`）：`manifest`（path/size/sha256/mtime）、`read`、`write`（临时文件 + fsync + 原子 rename）。只允许在 `CLUSTER_WS_ROOTS` / home / 临时目录 / 仓库根之内操作。
- 网关侧 `cluster/wssync.py`：并发取各节点清单 → 逐文件比对 → 冲突按 `newest`（最大 mtime）或 `prefer:<node>` 裁决 → 只搬差异（一次 read + N 次 write）→ 失败项逐项可重试（`attempt+1`，`retried` 计数）。
- 对照数据：两台机器同一个工作区里，`README.md` 在 Kali 侧被追加后同步，Windows 侧 sha256 变为 `3352ae25…`（冲突被记录、按 newest 裁决、字节真的过去了）。

```bash
# 网关（回环明文，给前端用；控制面依旧 mTLS，不用改一行）
python -m cluster ui --control https://127.0.0.1:18100 --tls-dir .state/tls --cert-name win --port 18150
```

### L6.5：DSH 前端（`dsh-plugin/`）

DeepSeek Harness 插件 `dsh-cluster-ui`：设置页「Cluster」+ 侧边栏/主面板「Cluster」+ 顶部 Router 对话框
（深色板 + 琥珀描边，明显区别于普通会话）+ 工作区同步状态页（逐节点/逐文件结果、冲突、重试）。
浏览器只与 DSH 同源通信，token 与 mTLS 证书都留在服务端。详见 [dsh-plugin/README.md](dsh-plugin/README.md)。

```bash
# 典型用法：给所有节点下发一次真实任务并逐节点回显
all skill:uppercase@1.0.0 {"text":"from the GUI"}
# -> ✓ kali-node: {"upper": "FROM THE GUI", "length": 12}
# -> ✓ win-node : {"upper": "FROM THE GUI", "length": 12}
```

## 安全边界与已知限制（重要，别跳过）

1. **Windows 非管理员不能建 TUN**：Wintun 适配器创建会失败（`Failed to create adapter`），防火墙加白也报 0x80070005。本项目因此默认 `--no-tun --use-smoltcp`：
   - 仍能拿到 mesh IP（`10.14.14.1`），**也能被对端访问**（smoltcp 把入站 TCP 转给本机服务）；
   - 但**不能主动连 mesh 网段**（`ping 10.14.14.2` 不通），所以 `[[peer]]` 引导必须写 underlay 真实 IP（`tcp://192.168.70.145:11010`），不能用 mesh IP。
   - 想要透明 IP 路由/子网代理，需要一次 UAC 提权装 Wintun（本项目不自动提权）。
2. **port-forward 在本机实测会让 easytier-core 退出**：no-tun 节点加 `port_forward` 规则后进程直接结束，故 `scripts/l0-win.ps1` **默认不建转发**（`-WithForwards` 才开），Windows→Kali 改走 underlay 地址；Agent 注册的是**多地址列表**（mesh IP + underlay IP），Router 逐个探测并缓存可用地址。
3. **quorum 与副本数**：2 个副本时 quorum=2，任一副本不可达就无法认领新任务（会排队）。生产建议 3 个控制面副本（quorum=2，容忍 1 台挂）。
4. **worker 是线程级隔离**，不是容器。要强隔离请把 `worker_mgr` 换成 Docker/WSL2/Job Object（接口已留）。
5. **共享工作区**（L6）只同步"新增/更新"，**不传播删除**；冲突策略只有 `newest` / `prefer:<node>`，没有三方合并；单文件读上限 2MB。要 Git worktree 级别隔离仍需自己接。
6. **进程存活**：`scripts/node-win.ps1` 用 `scripts/start_bg.py`（DETACHED_PROCESS + breakaway）拉起服务；但在"被自动化工具托管"的控制台里，EasyTier 仍可能被上游作业回收。**最稳的是在普通终端窗口里手工跑 `scripts\l0-win.ps1`**，或提权后注册为 Windows 服务。
7. **Kali 复用**：验证只用 `~/cluster-test/cluster-app`，没有碰机器上正在跑的 7890/12800/9020/12802。
8. **凭据**：`.state/tls/ca.key` 与各节点私钥在 `.gitignore` 里，不入库；仓库内只有代码、示例和脱敏证据。

## 目录

```
cluster/
├── cluster/                 # 实现（纯标准库）
│   ├── l0_network.py        # EasyTier 配置/进程/peer/port-forward + frp 模板
│   ├── l1_agent.py          # Node Agent：指标/能力/worker/本地 cap_router
│   ├── l2_control.py        # 控制面：Ledger/CAS/quorum/分派/准入
│   ├── l3_capability.py     # CapabilityDescriptor + 匹配
│   ├── l4_adapters.py       # MCP / Skill / API 适配器 + YAML 子集解析
│   ├── l5_orchestrator.py   # 提交/等待/容量判断/开子智能体
│   ├── ui_api.py            # L6 UI 网关（回环 HTTP + token，给 DSH 插件用）
│   ├── wssync.py            # L6 工作区同步：清单比对/冲突裁决/复制/重试
│   ├── policy.py            # 准入策略与打分
│   ├── metrics.py           # 跨平台指标（ctypes / /proc）
│   ├── mtls.py              # 自签 CA + 节点证书（openssl）
│   ├── httpjson.py          # JSON-over-HTTP（可选 mTLS）
│   ├── selfcheck.py         # 9 项内置断言
│   └── cli.py               # 命令行
├── scripts/
│   ├── l0-win.ps1 / l0-kali.sh     # 组网（一条命令）
│   ├── node-win.ps1 / node-kali.sh # 控制面 + Agent（一条命令）
│   └── start_bg.py                 # 真正脱离控制台的后台启动
├── dashboard/index.html      # 单文件实时面板（/ 直接打开）
├── examples/plugins/         # mcp/ skill/ api/ 三种示例插件（含 skills/ws：工作区同步执行器）
├── dsh-plugin/               # DeepSeek Harness 前端插件（设置页/主面板/Router 对话框/同步页）
├── tests/                    # 37 个 unittest
└── docs/                     # 设计说明与证据
```

## 命令行速查

```
cluster net fetch|init|up|status|forward|frp       L0
cluster certs init|issue|verify                    mTLS
cluster control|agent                              L2 / L1
cluster submit|status|caps                         L5
cluster ui                                          L6 UI 网关（给 DSH 插件用）
cluster demo|selfcheck                             演示与自检
```

控制面自带面板：浏览器打开 `https://<控制面>:18100/`（需要客户端证书；单机 demo 用 http 直接开）。

## 路线（还没做的）

- TUN 模式（需管理员）：拿到完整 mesh 路由后，`[[peer]]` 可写 mesh IP，port-forward 也不再需要；
- worker 容器化（Docker / WSL2 / Job Object）+ 每个 worker 的资源配额；
- 共享工作区的 Git worktree 隔离（当前的 L6 是"目录内容一致"，不是"每个任务独立分支"）；
- Watchdog：行为级检查 worker 是否卡死/跑偏（资源级已由准入覆盖）；
- MCP 的 resources/prompts/采样能力（当前只实现 tools）。

## License

MIT © ku-lin
