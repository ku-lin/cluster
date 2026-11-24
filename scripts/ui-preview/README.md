# UI 预览与对比截图环境

给 `dsh-plugin/lib/client.js`（cluster 面板）做视觉改动时，用它生成**同场景、同视口、
同主题**的改前/改后对比图，以及功能与响应式回归证据。

## 为什么自建而不是直接用 3080

- 3080 是使用者正在用的实例，不能为了看效果重启或热换面板。
- 对比图要求两侧跑在**同一份数据、同一时刻**上，否则「数字变了」会被误读成「设计变了」。
- 这套环境跑在 `127.0.0.1:3899`，只读仓库里的 `client.js`，不连 cluster 控制面（18100）
  也不连 UI 网关（18150）。

## 它有多"真"

| 部分 | 来源 |
| --- | --- |
| 插件代码 | 仓库里的 `dsh-plugin/lib/client.js`（`?which=after`）与 `git show HEAD:` 那一版（`?which=baseline`） |
| React | 真实 React 18.3.1 UMD（`react.production.min.js` + `react-dom.production.min.js`） |
| 主题 token | 从本机已装 DSH 主题包里**抽取**的 `--dsw-*` 变量块，见 `build-tokens.mjs` |
| 宿主契约 | 最小 `window.__ModuleLoader__` + `ctx.slots` / `ctx.layout` 壳，与宿主给插件的形状一致 |
| 接口数据 | `fixtures.mjs`，字段逐项对齐 `cluster/ui_api.py` 的 `hosts_view()` / `uisummary.*` |

时钟被冻结（`?now=`），`agoText()` 这类相对时间在两侧输出一致；滚动条隐藏；DPR 固定 1。

## 一次性准备

```powershell
cd S:\cluster
# React UMD 包（本仓库不装 node_modules，只借 .cache 放）
New-Item -ItemType Directory -Force .cache\ui-harness | Out-Null
npm pack react@18.3.1 react-dom@18.3.1 --pack-destination .cache\ui-harness
tar -xzf .cache\ui-harness\react-18.3.1.tgz      -C .cache\ui-harness
tar -xzf .cache\ui-harness\react-dom-18.3.1.tgz  -C .cache\ui-harness

# 主题 token（改主题版本后重跑）
node scripts\ui-preview\build-tokens.mjs
```

`ws` 从 `S:\deepseek_harness\node_modules\ws` 借用；换机器时改 `shoot.mjs` / `check.mjs` /
`responsive.mjs` / `compose.mjs` 顶部的 `wsEntry`。

## 日常用法

```powershell
# 1) 起预览服务（后台，默认 3899）
node scripts\ui-preview\server.mjs

# 2) 截图（两侧各跑一次，场景/视口完全相同）
node scripts\ui-preview\shoot.mjs --which baseline --out docs\evidence\ui-1.1.0\before
node scripts\ui-preview\shoot.mjs --which after    --out docs\evidence\ui-1.1.0\after

# 3) 拼「改前 | 改后」对比图（副标题的版本/哈希取自 /manifest）
node scripts\ui-preview\compose.mjs

# 4) 功能回归（24 条：20 条冒烟 + 4 条本版专属）
node scripts\ui-preview\check.mjs --which after
node scripts\ui-preview\check.mjs --which baseline

# 5) 定点复验本次修掉的四个缺陷
node scripts\ui-preview\verify-fixes.mjs

# 6) 响应式：12 个宽度（含 375/360 手机竖屏）
node scripts\ui-preview\responsive.mjs
node scripts\ui-preview\responsive.mjs --baseline
```

## 断言为什么分两组

`check.mjs` 的 24 条里，前 20 条是**冒烟**（元素在不在、入口还通不通），它们在
baseline 与 after 上**都应当全绿** —— 这证明"改样式没改坏行为"，但证明不了
"这个版本到底改了什么样"。后 4 条是**本版专属**（统计格两行且数值 ≥28px、内容留白、
设置页 token 被真正消费、路由 200 且关键字段齐全），它们必须在 after 通过、在
baseline 失败。

实测：after **24/24**，baseline **21/24**（失败的正是那三条视觉断言）。
如果哪天两侧都 24/24，说明这组断言失去了判别力，要重写。

## 基线身份怎么钉住

`server.mjs` 顶部的 `BASELINE_REV`（默认 `fc5ac39`）**写死**基线提交，不用 `HEAD`。

踩过的坑：最初写 `git show HEAD:...`，而服务启动那一刻 HEAD 已经是本次改动的
提交了 —— "改前"实际取到了"改后"，对比图照样生成、副标题照样印版本号，但两侧是
同一份代码。这种错误在图上完全看不出来。现在服务启动时会把两侧的 sha256 打出来，
并在两侧相同时告警；`/manifest` 供 `compose.mjs` 把哈希印在对比图上。

## 场景清单

| id | 内容 | 关键操作 |
| --- | --- | --- |
| `overview-light` | 首屏默认态 | 无 |
| `overview-dark` | 首屏暗色 | 无 |
| `overview-expanded-light` | 展开节点明细 | 点 `<details>` 后滚到底 |
| `overview-router-open-light` | Router 展开 | 点「展开对话」 |
| `sync-tab-light` | 工作区同步页 | 点标签页 |
| `settings-light` | 设置页 Cluster 板块 | 直接挂 `settings.section` |

## 注意

- 截图脚本会自己起一个一次性 headless Chrome（`--user-data-dir` 在 `.cache`），
  用完即杀；不碰使用者浏览器。
- `check.mjs` 里判断 `<details>` 是否真的展开用的是 `innerText` 长度，不是
  `getBoundingClientRect` / `offsetParent`——收起的内容仍有布局盒，那两个判据会误报。
- **预览服务对未实现的 API 路由返回 404**（早期版本返回 200 + error 字段，导致
  "八条路由都 200"在路径写错时也通过，等于没测）。
- 这些脚本**不参与**插件运行时，只服务开发期的对比取证。
