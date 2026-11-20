# 任务拆解与验收（可导入任务板）

> 说明：当前会话的 taskboard 只暴露了 list/get/claim/comment/relate/submit_review，
> **没有创建项目/任务的接口**，所以这份清单按任务板字段（标题/依赖/验收）落成文件，
> 可由任务板界面逐条录入；状态列与实际进展同步。

## P0 已完成（本次交付）

| # | 任务 | 依赖 | 验收条件 | 状态 |
|---|---|---|---|---|
| 1 | L0 组网：EasyTier 双端启动脚本 | — | `scripts/l0-win.ps1` / `l0-kali.sh` 一条命令拉起；`easytier-cli peer` 出现 `cost=p2p` | ✅ 已验证（0.38ms） |
| 2 | mTLS：自签 CA + 节点证书 | — | `cluster certs verify` OK；无客户端证书请求被拒 | ✅ 已验证 |
| 3 | L1 Node Agent：指标/能力/worker | 1,2 | 双端 `/health` 返回 caps=5；`/metrics` 有 cpu/mem/net | ✅ 已验证 |
| 4 | L3 能力注册：MCP/Skill/API 归一 | 3 | 注册表出现 3 种 kind、共 10 条能力 | ✅ 已验证 |
| 5 | L2 控制面双副本 + CAS 认领 | 2,3 | 两副本均可认领并分派；并发认领只有一个赢家 | ✅ 已验证（3 副本单测 + 双副本实测） |
| 6 | L2/L1 准入控制 | 3,5 | 指标超限时任务 `queued` 并给出原因 | ✅ 单测 + selfcheck |
| 7 | 跨机任务分派（Windows↔Kali） | 4,5,6 | Kali 专属能力在 kali 执行；Windows 专属能力在 win 执行 | ✅ 3 个任务实测 |
| 8 | L5 按容量开子智能体 | 4,5 | `maybe_spawn_subagent` 有容量返回 spawned，无容量返回 reason | ✅ selfcheck |
| 9 | 文档/许可证/CI | 1–8 | README 含限制与证据；MIT；CI 4 job 全绿 | ✅ |
| 10 | 公开仓库 | 9 | `github.com/ku-lin/cluster` 公开，首推 commit 含全部代码 | ✅ |

## P1 待做（下一轮）

| # | 任务 | 依赖 | 验收条件 |
|---|---|---|---|
| 11 | TUN 模式（管理员） | 1 | 提权后 `ping 10.14.14.2` 通，`[[peer]]` 可用 mesh IP，port-forward 不再需要；脚本加 `-UseTun` 开关 |
| 12 | worker 隔离 | 3 | 每个 worker 跑在容器/WSL2/Job Object，带 cpu/mem 限额；超限按准入拒绝 |
| 13 | 共享工作区 | 3 | 任务级 Git worktree（每任务独立分支），产物目录可配置 |
| 14 | Watchdog（行为级） | 12 | 卡死/跑偏的 worker 能被检测并终止，事件进 dispatch_log |
| 15 | 控制面 3 副本 | 5 | quorum=2，挂 1 副本仍可认领；k8s/裸机部署脚本 |
| 16 | MCP 全能力 | 4 | resources / prompts / 采样，Adapter 侧统一暴露 |
| 17 | 面板鉴权 | 5 | dashboard 走 mTLS 或 token，不再裸奔 |
| 18 | 指标通道分离 | 3,5 | 高频指标走独立通道（UDP/NATS），不占控制面 HTTP |

## 已知风险（承接自实测）

- Windows 非管理员：无 TUN、无防火墙改规则权限（UAC 一次可解）；
- `port_forward` 在本机 EasyTier 2.6.4 + no-tun 下会让进程退出 → 默认关闭；
- 2 副本 quorum=2：任一副本不可达则无法认领新任务（生产建议 3 副本）；
- 自动化工具托管的控制台里，EasyTier 可能被上游作业回收 → 用普通终端或注册服务。
