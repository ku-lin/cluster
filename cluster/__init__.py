"""cluster — 分布式多机 Agent 集群（L0 网络 → L5 编排）。

分层与职责（对应设计文档 README.md 的 L0~L5）：
  L0 l0_network      EasyTier mesh（局域网直连优先）/ frp 中心化兜底，只产出配置
  L1 l1_agent        Node Agent：指标采集、能力扫描、worker 生命周期、本地 cap_router
  L2 l2_control      控制面 Router：多副本、CAS 认领、准入控制、任务分派
  L3 l3_capability   统一能力描述 CapabilityDescriptor（MCP/Skill/API 归一）
  L4 l4_adapters     三种 Adapter：mcp / skill / api，统一 Invoke 协议
  L5 l5_orchestrator 编排：提交任务、按容量决定是否开新子智能体
"""

__version__ = "0.1.0"
