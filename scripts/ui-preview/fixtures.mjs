/**
 * 首屏 fixture：把网关 `GET /api/hosts` 的真实返回形状写死一份。
 *
 * 为什么用 fixture 而不是连真网关：
 *   1. 改前/改后必须逐像素可比。真实集群的 cpu/内存每 5 秒就变一个数，
 *      截图会"因为数据变了"而不一样，那样就分不清是设计改的还是数据改的。
 *   2. 这台机器上控制面（18100）和 UI 网关（18150）现在没起，3080 也不能重启，
 *      没有可连的真实数据源。
 *
 * 形状逐字段来自 cluster/ui_api.py 的 hosts_view() / uisummary.queue_summary() /
 * uisummary.workspace_summary()，字段名与嵌套层级一致；数值挑了一组能同时覆盖
 * 「正常 / 偏高 / 打满 / 离线」四档观感的组合，这样对比图里状态色、刻度、缺省值
 * 都会出现，不至于只看到一片绿色。
 *
 * 时间基准由调用方传入（截图脚本冻在同一个整秒）：面板里有 `agoText()` 这种相对
 * 时间，fixture 与浏览器时钟必须同源，否则「6m 前」在两次截图里会漂成「6m 前 /
 * 7m 前」，同场景对比就破了。
 */

/** 造一条 20 点的 CPU/内存采样，让趋势图有形状而不是直线。 */
function series(now, cpuBase, memBase, phase = 0) {
  const rows = []
  for (let i = 19; i >= 0; i -= 1) {
    const t = (19 - i) / 19
    rows.push({
      ts: now - i * 5,
      cpu: Math.round(Math.max(1, Math.min(99, cpuBase + Math.sin(t * 5 + phase) * 11 + (t * 6)))),
      mem: Math.round(Math.max(1, Math.min(99, memBase + Math.cos(t * 4 + phase) * 6))),
      workers: 2,
      agents: 5,
    })
  }
  return rows
}

const AGENTS_WIN = [
  { cap_id: 'mcp:fs@1.0.0', kind: 'mcp', status: 'idle', description: '文件系统 MCP' },
  { cap_id: 'mcp:http@1.0.0', kind: 'mcp', status: 'busy', description: 'HTTP 抓取 MCP', current_task: 't-4a91' },
  { cap_id: 'skill:uppercase@1.0.0', kind: 'skill', status: 'idle', description: '转大写' },
  { cap_id: 'skill:ws@1.0.0', kind: 'skill', status: 'idle', description: '工作区同步执行器' },
  { cap_id: 'api:cluster-health@1.0.0', kind: 'api', status: 'idle', description: '控制面健康' },
]

const AGENTS_KALI = [
  { cap_id: 'mcp:fs@1.0.0', kind: 'mcp', status: 'idle', description: '文件系统 MCP' },
  { cap_id: 'skill:uppercase@1.0.0', kind: 'skill', status: 'idle', description: '转大写' },
  { cap_id: 'skill:ws@1.0.0', kind: 'skill', status: 'idle', description: '工作区同步执行器' },
  { cap_id: 'api:kali-health@1.0.0', kind: 'api', status: 'down', description: 'Kali 健康检查' },
  { cap_id: 'mcp:shell@1.0.0', kind: 'mcp', status: 'idle', description: '本地 shell' },
]

/** 一个工作区记录 + 它最近一轮同步（uisummary.workspace_summary 的形状）。 */
function workspace(now) {
  return [
    {
      name: 'demo',
      policy: 'newest',
      created: now - 5400,
      last_status: 'done',
      last_run: 'wsr-8f21c4',
      last: {
        id: 'wsr-8f21c4',
        status: 'done',
        policy: 'newest',
        attempt: 1,
        created: now - 300,
        finished: now - 292,
        counts: { files: 18, in_sync: 15, copied: 3, conflicts: 0, failed: 0 },
        nodes: [
          { node_id: 'win-node', status: 'done', written: 2, manifest_files: 18, errors: [] },
          { node_id: 'kali-node', status: 'done', written: 1, manifest_files: 18, errors: [] },
        ],
        error: null,
      },
    },
    {
      name: 'notes',
      policy: 'prefer:kali-node',
      created: now - 90000,
      last_status: 'partial',
      last_run: 'wsr-77ab10',
      last: {
        id: 'wsr-77ab10',
        status: 'partial',
        policy: 'prefer:kali-node',
        attempt: 2,
        created: now - 7200,
        finished: now - 7188,
        counts: { files: 9, in_sync: 6, copied: 2, conflicts: 1, failed: 1 },
        nodes: [
          { node_id: 'win-node', status: 'done', written: 1, manifest_files: 9, errors: [] },
          { node_id: 'kali-node', status: 'partial', written: 1, manifest_files: 9, errors: ['EACCES: notes/plan.md'] },
        ],
        error: null,
      },
    },
  ]
}

/** 所有 fixture 都从同一个 now 派生，保证相对时间一致。 */
export function buildFixtures(now) {
  const hosts = {
    upstream: { control: 'https://127.0.0.1:18100', ok: true, rtt_ms: 41.6, ts: now },
    router: {
      node_id: 'win-node',
      url: 'https://10.14.14.1:18100',
      peers: ['kali-node'],
      quorum: 2,
      uptime_s: 14272,
      policy: { min_free_mem_mb: 512, max_cpu_percent: 92 },
    },
    summary: { nodes: 2, alive: 2, agents: 10, tasks_running: 1, tasks_total: 47 },
    quorum: 2,
    peers: ['kali-node'],
    queue: {
      counts: { waiting: 2, running: 1, done: 41, failed: 2, cancelled: 1, unknown: 0 },
      total: 47,
    },
    workspaces: workspace(now),
    items: [
      {
        node_id: 'win-node',
        role: 'router',
        os: 'windows',
        mesh_ip: '10.14.14.1',
        url: 'https://127.0.0.1:18100',
        urls: ['https://127.0.0.1:18100'],
        reachable_url: 'https://127.0.0.1:18100',
        alive: true,
        metrics: {
          cpu_percent: 34.2,
          mem_percent: 62.8,
          mem_used_mb: 10112,
          mem_total_mb: 16384,
          net_in_rate: 412000,
          net_out_rate: 188400,
          net_unit: 'bytes/s',
          workers: 2,
          max_workers: 4,
          cpu_count: 12,
          uptime_s: 14272,
          ts: now - 3,
        },
        metrics_age_s: 3,
        agents: AGENTS_WIN,
        agent_count: AGENTS_WIN.length,
        history: series(now, 30, 60, 0),
        plugin_errors: [],
        task_counts: { running: 1, done: 28, failed: 1 },
      },
      {
        node_id: 'kali-node',
        role: 'node',
        os: 'linux',
        mesh_ip: '10.14.14.2',
        url: 'https://10.14.14.2:17100',
        urls: ['https://10.14.14.2:17100'],
        reachable_url: 'https://10.14.14.2:17100',
        alive: true,
        metrics: {
          cpu_percent: 91.4,
          mem_percent: 88.1,
          mem_used_mb: 3512,
          mem_total_mb: 4096,
          net_in_rate: 92000,
          net_out_rate: 61000,
          net_unit: 'bytes/s',
          workers: 2,
          max_workers: 2,
          cpu_count: 4,
          uptime_s: 38000,
          ts: now - 9,
        },
        metrics_age_s: 9,
        agents: AGENTS_KALI,
        agent_count: AGENTS_KALI.length,
        history: series(now, 82, 84, 1.1),
        plugin_errors: [],
        task_counts: { running: 0, done: 19, failed: 1 },
      },
    ],
  }

  const tasks = {
    items: [
      { id: 't-4a91c2', cap_id: 'mcp:http@1.0.0', node_id: 'win-node', status: 'running' },
      { id: 't-77de10', cap_id: 'skill:uppercase@1.0.0', node_id: 'kali-node', status: 'done' },
      { id: 't-2b0c55', cap_id: 'skill:ws@1.0.0', node_id: 'win-node', status: 'failed' },
      { id: 't-91fa03', cap_id: 'api:cluster-health@1.0.0', node_id: 'win-node', status: 'done' },
      { id: 't-6c2d77', cap_id: 'mcp:fs@1.0.0', node_id: 'kali-node', status: 'done' },
    ],
    count: 5,
  }

  const transcript = {
    items: [
      { role: 'user', text: 'kali 现在负载怎么样', ts: now - 900 },
      {
        role: 'router',
        text: 'kali-node 的 CPU 已经到 91%，内存 88%，两个 worker 都在忙。win-node 还有余量（CPU 34%），建议这一轮交给 win-node。',
        ts: now - 895,
        source: 'llm',
        model: 'deepseek-chat',
        elapsed_ms: 2140,
        usage: { inputTokens: 1820, outputTokens: 96 },
        actions: [{ kind: 'tool', name: 'cluster_hosts', status: 'ok', elapsed_ms: 41 }],
      },
      { role: 'user', text: '在 win-node 上跑 skill:uppercase，文本 hello', ts: now - 600 },
      {
        role: 'router',
        text: '已在 win-node 上执行 skill:uppercase@1.0.0，输出 HELLO，用时 18.5ms。',
        ts: now - 594,
        source: 'llm',
        model: 'deepseek-chat',
        elapsed_ms: 1620,
        usage: { inputTokens: 1640, outputTokens: 64 },
        actions: [{ kind: 'invoke', cap_id: 'skill:uppercase@1.0.0', node_id: 'win-node', status: 'done', elapsed_ms: 18.5 }],
      },
    ],
  }

  const workspaces = {
    items: hosts.workspaces.map((row) => ({
      name: row.name,
      policy: row.policy,
      created: row.created,
      last_status: row.last_status,
      last_run: row.last_run,
      roots: {
        'win-node': `S:\\cluster\\.state\\workspaces\\${row.name}`,
        'kali-node': `/home/kali/cluster-test/workspaces/${row.name}`,
      },
    })),
    nodes: [
      { node_id: 'win-node', os: 'windows' },
      { node_id: 'kali-node', os: 'linux' },
    ],
  }

  const syncRuns = {
    runs: [
      {
        id: 'wsr-8f21c4',
        workspace: 'demo',
        status: 'done',
        policy: 'newest',
        attempt: 1,
        created: now - 300,
        finished: now - 292,
        updated: now - 292,
        counts: { files: 18, in_sync: 15, copied: 3, conflicts: 0, failed: 0 },
        nodes: {
          'win-node': { node_id: 'win-node', status: 'done', written: 2, manifest_files: 18, errors: [] },
          'kali-node': { node_id: 'kali-node', status: 'done', written: 1, manifest_files: 18, errors: [] },
        },
        items: [
          { path: 'README.md', status: 'in_sync', from: null, to: [], error: null },
          { path: 'notes/plan.md', status: 'copied', from: 'win-node', to: ['kali-node'], error: null },
          { path: 'data/a.csv', status: 'copied', from: 'kali-node', to: ['win-node'], error: null },
        ],
        conflicts: [],
        log: ['[ws] manifest 18 files', '[ws] copied 3', '[ws] done'],
        error: null,
      },
      {
        id: 'wsr-77ab10',
        workspace: 'notes',
        status: 'partial',
        policy: 'prefer:kali-node',
        attempt: 2,
        created: now - 7200,
        finished: now - 7188,
        updated: now - 7188,
        counts: { files: 9, in_sync: 6, copied: 2, conflicts: 1, failed: 1 },
        nodes: {
          'win-node': { node_id: 'win-node', status: 'done', written: 1, manifest_files: 9, errors: [] },
          'kali-node': { node_id: 'kali-node', status: 'partial', written: 1, manifest_files: 9, errors: ['EACCES: notes/plan.md'] },
        },
        items: [
          { path: 'notes/plan.md', status: 'failed', from: 'win-node', to: [], error: 'EACCES' },
          { path: 'notes/draft.md', status: 'conflict', from: null, to: [], error: null },
        ],
        conflicts: [
          { path: 'notes/draft.md', winner: 'kali-node', policy: 'prefer:kali-node', sha_by_node: { 'win-node': 'a91f2c4471d0', 'kali-node': 'b72c8a1e3f44' } },
        ],
        log: ['[ws] conflict notes/draft.md -> kali-node'],
        error: null,
      },
    ],
  }

  const health = {
    ok: true,
    control: 'https://127.0.0.1:18100',
    tls: { enabled: true, dir: 'S:\\cluster\\.state\\tls', cert_name: 'win' },
    token_file: 'S:\\cluster\\.state\\ui\\token',
    state_dir: 'S:\\cluster\\.state',
    ts: now - 2,
  }

  const routerStatus = { enabled: true, preset: 'cluster-router', session: 'cluster-router', turns: 2 }

  return { hosts, tasks, transcript, workspaces, syncRuns, health, routerStatus }
}
