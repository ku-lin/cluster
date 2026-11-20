# Changelog

本仓库的版本号按 [SemVer](https://semver.org/lang/zh-CN/) 解释：`vX.Y.Z` 是**仓库**的发布版本；
`dsh-plugin/package.json` 的版本是**插件包自身**的版本，二者独立维护（首次发布时一一对应）。

## Unreleased（2026-11-20）— Notice

**README 标注「暂时不能使用」。** 仓库根 `README.md` 与 `dsh-plugin/README.md` 顶部已加警告块，
原因：项目仍在开发中，DSH 插件、Router 会话与工作区同步的接口/配置仍在快速变动，可能无通知变更。
本次只改文档，不动代码；不新建 tag，不改 Release。

## v1.0.0 — 2026-11-20

**首个公开版本：core 与 `dsh-cluster-ui 1.0.0` 一并首发。**

仓库此前没有 tag / Release，因此按"首次发布"处理，仓库版本号从 `v1.0.0` 起算
（而不是用 `v1.1.0` 表示"加入 DSH 插件"）。

### 新增

- **DSH 前端插件 `dsh-cluster-ui 1.0.0`**（`dsh-plugin/`），四个落点：
  - 设置页「Cluster」：工作区列表 + 新建工作区（创建即触发全节点同步）
  - 侧边栏 / 主面板「Cluster」：主机卡片（CPU/内存/网络/worker/mesh IP）+ 展开看 agents，5 秒刷新
  - 主面板顶部 Router 对话框：深色板 + 琥珀描边，消息按规则真实下发并逐节点回显
  - 工作区同步页：逐节点/逐文件结果、冲突双 sha256、失败重试
- **L6 工作区同步**：`cluster/wssync.py`（清单比对 / `newest` 与 `prefer:<node>` 冲突裁决 / 只搬差异 / 逐项重试）
  + 节点侧执行器 `skill:ws@1.0.0`（`examples/plugins/skills/ws/`，manifest/read/write/stat，realpath 防穿越）。
- **L6 UI 网关**：`cluster/ui_api.py` + `python -m cluster ui`，回环 HTTP + Bearer token，把控制面/节点包成 `/api/*`；
  浏览器不直连，token 与 mTLS 证书都留在服务端。
- Windows 后台启动支持 `cluster/winproc.py`（隐藏控制台窗口）。

### 兼容性

- DSH `0.2.1-rc.2` 实测（插件声明 `engines.dsh >= 0.2.1-alpha.2`）；Node `^22.19.0 || >=24`。
- Python ≥ 3.10，纯标准库；mTLS 需要 `openssl` 可执行文件。

### 已知限制

- Router 是**规则路由器**，不是 LLM；认不出的文本明确回「没看懂」+ 指令表。
- 工作区同步只覆盖新增/更新，**不传播删除**；无三方合并；单文件读上限 2MB，单节点清单上限 5000 个文件。
- Windows 非管理员不能建 TUN：no-tun 节点到不了 mesh 网段，`[[peer]]` 必须写 underlay IP，且加 `port_forward` 会让 `easytier-core` 退出。
- 网络指标单位随平台（Windows `packets/s`，Linux `bytes/s`），面板不换算。
- worker 是线程级隔离，不是容器。
