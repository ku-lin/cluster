> [!WARNING]
> **暂时不能使用（2026-11-20）**：插件仍处开发中，UI 落点、代理接口与配置项都可能随时变动，
> 请勿在生产或比赛环境直接依赖；试用请固定到 `v1.0.0` 对应的 tag。

# dsh-cluster-ui — DeepSeek Harness 里的 cluster 前端

把 [cluster](https://github.com/ku-lin/cluster)（多机 Agent 集群）的**主机状态、agent、Router 对话、工作区同步**搬进 DSH 界面。
插件本身不含集群实现：它只当一个**同源代理 + 三块 UI**，数据全部来自 `python -m cluster ui` 起的回环网关。

四个落点：

| 位置 | 内容 |
| --- | --- |
| 设置页 → **Cluster** | 集群工作区列表（每节点根目录 + 最近一次同步状态）、**新建 cluster 工作区**（创建后立即触发全节点同步）、跳到主面板 |
| 侧边栏 → **Cluster** → 主面板「主机与 agents」 | 每台主机一张卡片：CPU / 内存 / 网络速率 / worker 数 / mesh IP / 采样时间；「展开」看该主机下挂的 agent（cap_id、kind、idle/busy/down）。5 秒自动刷新 |
| 主面板顶部 **Router 对话框** | 深色板 + 琥珀描边的常驻对话区，和普通会话视觉上分开；发一条消息由 cluster 的 L2/节点真实执行，回显逐节点结果 |
| 主面板 → **工作区同步** | 每个工作区、每次同步的逐节点结果（清单文件/写入数/错误）、逐文件结果（in_sync / copied / conflict / failed）、冲突双方 sha256 与胜出方、**重试失败项** |

## 架构：为什么浏览器不直连 cluster

```
浏览器 ──同源 /cluster-ui/api/*──> DSH host（lib/index.js 代理）
                                        │  回环 HTTP + Authorization: Bearer <state_dir>/ui/token
                                        ▼
                              cluster UI 网关（python -m cluster ui，127.0.0.1:18150）
                                        │  mTLS（节点客户端证书）
                                        ▼
                        控制面副本（*-router）  ←→  Node Agent（*-node）
```

四个理由：

1. **token 不下发浏览器**。网关 token 只存在 `<cluster 仓库>/.state/ui/token`（0600），由 host 侧读取后附加；页面拿不到。
2. **控制面不用改**。控制面是 mTLS 的，浏览器既没有节点私钥也不该有；证书只在 Python 进程里。
3. **没有 CORS / 混合内容问题**。浏览器只跟 DSH 自己同源通信；host 代理还会校验 Host 必须是回环、Origin 必须与 Host 一致。
4. **热加载也能用**。profile 若声明 `patchReload: live`（配合 dsh-hmr），改 `cordis.patch.yml` 后重组合，不需要重启 DSH。

## 依赖与前置条件

| 依赖 | 说明 |
| --- | --- |
| DSH ≥ `0.2.1-alpha.2` | 需要 `ctx.slots`（`main` / `sidebar.panellist` / `settings.section`）与 `ctx.webServer.register`；**实测版本 0.2.1-rc.2** |
| Node ≥ 22.19（或 ≥ 24） | host 侧只用内置 `node:fs` 与全局 `fetch`，无第三方依赖 |
| cluster UI 网关 | `python -m cluster ui --control https://127.0.0.1:18100 --tls-dir .state/tls --cert-name <节点证书名> --port 18150` |
| 每个节点上的 `skill:ws@1.0.0` | 工作区同步的节点侧执行器：`<cluster 仓库>/examples/plugins/skills/ws/` |
| 构建 | **无**。`lib/client.js` 是 `window.__ModuleLoader__` 格式的成品 bundle，`lib/index.js` 是普通 ESM |

## 安装

### 方式 A：本地 link（开发/自用，可热加载）

```powershell
# 1) 把插件目录 link 进 profile 的 node_modules（Windows 用 junction，*nix 用 symlink）
cmd /c mklink /J "<DSH profile>\node_modules\dsh-cluster-ui" "<cluster 仓库>\dsh-plugin"
#   *nix: ln -s "<cluster 仓库>/dsh-plugin" "<DSH profile>/node_modules/dsh-cluster-ui"

# 2) profile 的 package.json 的 dependencies 里记一行（只为可复现，运行时不读它）
#    "dsh-cluster-ui": "link:<cluster 仓库>/dsh-plugin"

# 3) profile 的 cordis.patch.yml 末尾加（或在 设置 → 插件 里启用）
#    - insert:
#        - id: dsh-cluster-ui
#          name: dsh-cluster-ui
#          config:
#            gatewayUrl: http://127.0.0.1:18150
#            tokenFile: <cluster 仓库>/.state/ui/token
```

profile 声明了 `"patchReload": "live"` 时，保存补丁后 host 会热重组合；**刷新页面**即可看到侧边栏「Cluster」，不需要重启 DSH。

### 方式 B：bundle 安装

```bash
dsh plugin add <cluster 仓库>/dsh-plugin    # 相对路径按调用目录解析
```

`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，安装时自动插入同样的插件行。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `gatewayUrl` | `http://127.0.0.1:18150`（或 `CLUSTER_UI_GATEWAY_URL`） | cluster UI 网关地址；只应指向回环 |
| `tokenFile` | `CLUSTER_UI_TOKEN_FILE` | 网关 token 文件路径；网关首次启动自动生成 32 字节 hex |
| `token` | 空 | 直接给明文 token（优先级最高，调试用；别写进仓库） |
| `timeoutMs` | `20000` | 单次代理 HTTP 往返超时 |

token 解析优先级：`config.token` → `CLUSTER_UI_TOKEN` → `config.tokenFile` → `CLUSTER_UI_TOKEN_FILE`。
四个都没配时，代理返回 503 并给出启动网关的提示；不会静默失败。

## 权限说明（这个插件能做什么、不能做什么）

- **能**：读写你指定的 token 文件；以 `Authorization: Bearer` 访问 `gatewayUrl`；在 DSH host 上注册一个 `/cluster-ui/api/*` 前缀路由；在浏览器侧注册 `settings.section`、`sidebar.panellist`、`main` 三个 slot 的 UI。
- **不能**：不读控制面的 mTLS 私钥（证书只在 Python 网关进程里）；不监听端口（复用 `ctx.webServer`）；不执行任意命令（所有动作都走网关的固定 HTTP 契约）；不把 token 交给页面。
- **路由访问控制**：主机侧只接受回环 Host（`127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`），Origin 若存在必须与 Host 一致；网关侧只监听 `127.0.0.1`，CORS 默认只放行 `http://127.0.0.1:3080` 与 `http://localhost:3080`。
- **工作区同步的写盘范围**由节点侧 `skill:ws` 的 `CLUSTER_WS_ROOTS` 决定：只在该变量（默认 home + 临时目录 + 仓库根）之内写文件，且 realpath 归一后按最长前缀校验，防 `../` 与符号链接逃逸。

## HTTP 契约（前端唯一依赖）

全部挂在 `/cluster-ui/api/*`（host 代理），除 `health` 外由网关校验 `Authorization: Bearer <token>`。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/health` | 网关自身与上游地址（免 token） |
| GET | `/cluster` | 控制面原始视图（router/nodes/capabilities） |
| GET | `/hosts` | **主机 + 指标 + 挂在其下的 agents**（主数据源） |
| GET | `/agents` | 扁平 agents 列表（含 `status: idle/busy/down`、`current_task`） |
| GET | `/tasks?limit=` | 最近任务 |
| GET | `/router/transcript?limit=` | Router 对话记录 |
| POST | `/router/message` | `{"text": "..."}` → `{"text", "actions": [...]}`，对话驱动任务 |
| GET | `/workspaces` | 工作区列表 + 在线节点 |
| POST | `/workspaces` | `{"name","policy","seed"}`：创建工作区并**立即触发同步** |
| GET | `/workspaces/<name>/tree` | 各节点真实文件清单 |
| POST | `/workspace/sync` | `{"workspace"}` → 起一轮同步 |
| GET | `/workspace/sync/status[?run_id=]` | 单次同步详情 / 最近 10 次 |
| POST | `/workspace/sync/retry` | `{"run_id"}`：只重试失败项（`attempt+1`，逐项 `retried`） |

### Router 指令（服务端 `cluster/ui_api.py` 的 `_route`）

| 指令 | 行为 |
| --- | --- |
| `status` / `状态` | 集群概况（副本、节点、能力、任务） |
| `hosts` / `主机` | 逐主机一行指标 |
| `caps` / `能力` | 全部能力（= 可调度 worker） |
| `tasks [n]` | 最近任务 |
| `run <cap_id> [json]` | 交给 **L2 控制面**：按准入 + 负载挑节点，返回真实结果 |
| `all <cap_id> [json]` | 每个持有该能力的节点**各跑一次**（真并发，逐节点结果） |
| `on <node> <cap_id> [json]` | 点名到节点（走 Node Agent `/invoke`） |
| `sync [workspace]` | 触发工作区同步 |
| `help` / `帮助` | 指令表 |

认不出的文本会明确回「没看懂」+ 指令表，不会编一个结果。

## 已知限制（重要，别跳过）

- **Router 是规则路由器，不是 LLM**。按上面的指令表解析后真实下发，不会自由发挥。「让 LLM 决定派给谁」当前没做。
- **同步只覆盖新增/更新，不传播删除**（对端多出来的文件不会被删）。策略只有 `newest` / `prefer:<node>`，没有三方合并。
- **单文件读上限 2MB**（`skill:ws` 的 `max_bytes`），超了记 `failed` 并写明原因；单节点清单上限 5000 个文件。
- **网络指标单位随平台**：Windows 是 `packets/s`（`iphlpapi` 只给报文数），Linux 是 `bytes/s`；面板按单位显示，不换算。
- **`workers` 计数来自 Agent 自己的 worker 表**，只统计经控制面派发的任务；`/invoke`（点名/fanout/同步）不占 worker。
- **Windows 非管理员不能建 TUN**：no-tun 节点到不了 mesh 网段，网关取节点地址时会回退到 underlay 地址。

## 卸载 / 回滚

```bash
# 1) 停用（热卸，不重启）：给 profile cordis.patch.yml 里那行加 disabled: true
# 2) 彻底移除：删掉该 insert 段 + 删 node_modules 里的 link/junction
rm "<DSH profile>/node_modules/dsh-cluster-ui"   # Windows: Remove-Item -Force
```

停用插件不影响 cluster 本身（网关与节点照常跑，`python -m cluster status` 依旧可用）。

## 目录

```
dsh-plugin/
  package.json          # dsh.client.inject / dsh.bundle.patch 声明
  cordis.patch.yml      # bundle 层插入行（方式 B 用）
  lib/index.js          # host：/cluster-ui/api/* 同源代理（读 token、同源校验、超时）
  lib/client.js         # client：window.__ModuleLoader__ 成品 bundle（三个 slot 的注册与全部 UI）
  LICENSE
  README.md
```
