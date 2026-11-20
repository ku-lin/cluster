/**
 * dsh-cluster-ui — 浏览器（client）一侧。
 *
 * 三个落点（对应需求的三条）：
 *   1. `settings.section`  id=cluster          设置页里的「Cluster」：列出集群、新建 cluster 工作区
 *   2. `main` + `sidebar.panellist` key=dsh-cluster-ui
 *                                             主面板「Cluster」：主机卡片（CPU/内存/网络/worker）+ 展开看 agents
 *                                             + 顶部 Router 对话框（独立配色/边框，明显区别于普通会话）
 *                                             + 「同步」页：每个节点/每个文件的同步结果、冲突、重试
 *   3. Router 对话框发送消息 -> POST /cluster-ui/api/router/message（服务端转发到 cluster 网关）
 *
 * 说明：这里刻意不引 UI 组件库、不做构建步骤——`lib/client.js` 就是交给
 * dsh-client-modules 加载的成品 bundle（它要求预构建产物）。所有请求都走同源
 * `/cluster-ui/api/*`，由 host 侧代理并附 token。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cluster-ui',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const react = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = react



const PANEL_ID = 'dsh-cluster-ui'
const API = '/cluster-ui/api'

/* ------------------------------------------------------------------ 数据层 */
async function request(path, init) {
  const options = { ...init }
  const response = await fetch(`${API}${path}`, options)
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { error: text.slice(0, 400) }
  }
  if (!response.ok) {
    const error = new Error((data && data.error) || `HTTP ${response.status}`)
    error.status = response.status
    error.payload = data
    throw error
  }
  return data
}
const getJSON = (path) => request(path)
const postJSON = (path, body) =>
  request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })

/* ------------------------------------------------------------------ 小工具 */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const percent = (value) => {
  const n = num(value)
  return n === null ? '—' : `${Math.round(n)}%`
}
function rateText(value, unit) {
  const n = num(value)
  if (n === null) return '—'
  const text = n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}M` : n >= 1024 ? `${(n / 1024).toFixed(1)}k` : `${Math.round(n)}`
  return unit === 'bytes/s' ? `${text}B/s` : unit === 'packets/s' ? `${text}pkt/s` : `${text}/s`
}
function agoText(ts) {
  const n = num(ts)
  if (!n) return '—'
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - n))
  if (seconds < 60) return `${seconds}s 前`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m 前`
  return `${Math.round(seconds / 3600)}h 前`
}
const toneOfNode = (host) => (host.alive ? (num(host.metrics && host.metrics.ts) && Date.now() / 1000 - host.metrics.ts > 30 ? 'warn' : 'ok') : 'bad')
const toneOfAgent = (agent) => (agent.status === 'busy' ? 'busy' : agent.status === 'down' ? 'bad' : 'ok')

/* ------------------------------------------------------------------ 样式 */
const STYLE_ID = 'dsh-cluster-ui-style'
const CSS = `
.dcu-root { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.dcu-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px 10px; }
.dcu-title { font-size: 15px; font-weight: 600; letter-spacing: .2px; }
.dcu-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dcu-spacer { flex: 1 1 auto; }
.dcu-btn { border: 0.5px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.dcu-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dcu-btn:disabled { opacity: .5; cursor: default; }
.dcu-btn.primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); border-color: transparent; }
.dcu-btn.warn { border-color: #c98b3a; color: #9a6520; }
.dcu-chip { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 1px 8px; font-size: 11px; border: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); }
.dcu-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: 0 0 auto; }
.dcu-dot.ok { background: var(--dsw-alias-state-success-primary); }
.dcu-dot.warn { background: var(--dsw-alias-state-warn-primary); }
.dcu-dot.bad { background: var(--dsw-alias-state-error-primary); }
.dcu-dot.busy { background: var(--dsw-alias-brand-primary); }
.dcu-tabs { display: flex; gap: 4px; padding: 0 18px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.dcu-tab { border: 0; background: transparent; color: var(--dsw-alias-label-tertiary); padding: 7px 10px; font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; }
.dcu-tab[data-active="true"] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
.dcu-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px 18px 22px; display: flex; flex-direction: column; gap: 12px; }
.dcu-error { border: 0.5px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); border-radius: 10px; padding: 8px 10px; font-size: 12px; }
.dcu-summary { display: flex; flex-wrap: wrap; gap: 8px; }
.dcu-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.dcu-card { border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 14px; padding: 12px 14px; background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.dcu-card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dcu-node { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcu-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; }
.dcu-meter { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dcu-meter-head { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.dcu-meter-track { height: 5px; border-radius: 999px; background: var(--dsw-alias-bg-layer-3); overflow: hidden; }
.dcu-meter-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); }
.dcu-meter-fill.warn { background: var(--dsw-alias-state-warn-primary); }
.dcu-meter-fill.bad { background: var(--dsw-alias-state-error-primary); }
.dcu-kv { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dcu-kv b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.dcu-agents { display: flex; flex-direction: column; gap: 3px; border-top: 0.5px dashed var(--dsw-alias-border-l3); padding-top: 8px; }
.dcu-agent { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto auto; gap: 8px; align-items: center; font-size: 12px; }
.dcu-agent-id { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcu-muted { color: var(--dsw-alias-label-tertiary); }
/* Router 对话框：深色板 + 琥珀描边，刻意和普通会话的浅色输入框拉开距离 */
.dcu-router { margin: 0 18px 12px; border-radius: 14px; border: 1px solid rgba(201, 139, 58, .75); background: linear-gradient(180deg, #241a11 0%, #161210 100%); color: #f4e8d6; box-shadow: 0 10px 26px rgba(0, 0, 0, .18); display: flex; flex-direction: column; min-height: 0; }
.dcu-router-head { display: flex; align-items: center; gap: 8px; padding: 9px 13px 7px; border-bottom: 1px solid rgba(201, 139, 58, .35); }
.dcu-router-title { font-size: 12.5px; font-weight: 700; letter-spacing: .6px; color: #f0c07a; text-transform: uppercase; }
.dcu-router-tag { font-size: 11px; color: rgba(244, 232, 214, .62); }
.dcu-router-log { max-height: 158px; overflow: auto; padding: 9px 13px; display: flex; flex-direction: column; gap: 7px; font-size: 12.5px; line-height: 1.5; }
.dcu-turn { display: flex; flex-direction: column; gap: 3px; }
.dcu-turn-user { color: #f0c07a; font-weight: 600; }
.dcu-turn-reply { color: #efe4d3; white-space: pre-wrap; word-break: break-word; }
.dcu-turn-meta { font-size: 11px; color: rgba(244, 232, 214, .5); }
.dcu-actions { display: flex; flex-wrap: wrap; gap: 5px; }
.dcu-action { font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 11px; border: 1px solid rgba(201, 139, 58, .4); border-radius: 6px; padding: 1px 6px; color: #e8d3b3; }
.dcu-router-input { display: flex; gap: 8px; padding: 9px 13px 11px; border-top: 1px solid rgba(201, 139, 58, .35); align-items: flex-end; }
.dcu-router-input textarea { flex: 1 1 auto; resize: none; min-height: 34px; max-height: 96px; border-radius: 9px; border: 1px solid rgba(201, 139, 58, .45); background: rgba(0, 0, 0, .28); color: #f4e8d6; padding: 8px 10px; font-size: 12.5px; font-family: inherit; outline: none; }
.dcu-router-input textarea::placeholder { color: rgba(244, 232, 214, .42); }
.dcu-router-send { border: 1px solid rgba(201, 139, 58, .6); background: rgba(201, 139, 58, .18); color: #f0c07a; border-radius: 9px; padding: 8px 12px; font-size: 12.5px; cursor: pointer; }
.dcu-router-send:disabled { opacity: .45; cursor: default; }
.dcu-hint { padding: 0 13px 9px; font-size: 11px; color: rgba(244, 232, 214, .45); }
.dcu-run { border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 12px; padding: 11px 13px; display: flex; flex-direction: column; gap: 9px; background: var(--dsw-alias-bg-layer-1); }
.dcu-run-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dcu-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dcu-table th { text-align: left; font-weight: 500; color: var(--dsw-alias-label-tertiary); padding: 4px 6px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.dcu-table td { padding: 4px 6px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); vertical-align: top; }
.dcu-mono { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; }
.dcu-badge { border-radius: 6px; padding: 0 6px; font-size: 11px; border: 0.5px solid var(--dsw-alias-border-l3); }
.dcu-badge.done { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.dcu-badge.partial, .dcu-badge.conflict { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.dcu-badge.failed { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dcu-badge.running { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dcu-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dcu-input { border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 8px; padding: 5px 9px; font-size: 12.5px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dcu-select { border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 8px; padding: 5px 8px; font-size: 12.5px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dcu-section-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.dcu-settings { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 8px; }
.dcu-settings .dcu-card { background: var(--dsw-alias-bg-layer-1); }
.dcu-roots { display: flex; flex-direction: column; gap: 2px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
`

function ensureStyle() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/* ------------------------------------------------------------------ 基础件 */
function Dot({ tone }) {
  return h('span', { className: `dcu-dot ${tone}` })
}

function Meter({ label, value, detail, invert }) {
  const n = num(value)
  const level = n === null ? '' : n >= 90 ? 'bad' : n >= 75 ? 'warn' : ''
  return h(
    'div',
    { className: 'dcu-meter' },
    h('div', { className: 'dcu-meter-head' }, h('span', null, label), h('span', null, detail || percent(value))),
    h('div', { className: 'dcu-meter-track' }, h('div', { className: `dcu-meter-fill ${invert ? '' : level}`, style: { width: `${n === null ? 0 : Math.max(0, Math.min(100, n))}%` } })),
  )
}

/* ------------------------------------------------------------------ Router */
function RouterBox({ onAfter }) {
  const [items, setItems] = useState([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const logRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const data = await getJSON('/router/transcript?limit=20')
      setItems(data.items || [])
    } catch (failure) {
      setError(String(failure.message || failure))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const node = logRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [items])

  const send = async () => {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    try {
      const reply = await postJSON('/router/message', { text })
      setDraft('')
      setItems((current) => [...current, { role: 'user', text, ts: reply.ts, local: true }, reply])
      if (onAfter) onAfter(reply)
    } catch (failure) {
      setError(String(failure.message || failure))
    } finally {
      setBusy(false)
    }
  }

  return h(
    'section',
    {
      className: 'dcu-router',
      'aria-label': 'Router 对话框',
      // 内联背景：主题插件（dream skin）有一条 `[data-dsh-dream-skin-composer]{background:transparent}`
      // 的规则会盖掉同名 class 的 background，而 Router 板块必须保持深色才和普通会话拉开距离。
      style: { background: 'linear-gradient(180deg, #241a11 0%, #161210 100%)' },
    },
    h(
      'header',
      { className: 'dcu-router-head' },
      h(Dot, { tone: busy ? 'warn' : 'ok' }),
      h('span', { className: 'dcu-router-title' }, 'Router · 常驻'),
      h('span', { className: 'dcu-router-tag' }, '直接对话驱动全部 worker（不是普通会话）'),
      h('span', { className: 'dcu-spacer' }),
      h('button', { className: 'dcu-btn', style: { background: 'transparent', color: '#f0c07a', borderColor: 'rgba(201,139,58,.45)' }, onClick: load, disabled: busy }, '刷新记录'),
    ),
    h(
      'div',
      { className: 'dcu-router-log', ref: logRef },
      items.length === 0
        ? h('div', { className: 'dcu-turn-meta' }, '还没有对话。试试：status / hosts / all skill:uppercase@1.0.0 {"text":"hi"} / sync demo')
        : items.map((item, index) =>
            h(
              'div',
              { className: 'dcu-turn', key: `${item.ts}-${index}` },
              h('div', { className: item.role === 'user' ? 'dcu-turn-user' : 'dcu-turn-reply' }, item.role === 'user' ? `› ${item.text}` : item.text),
              item.actions && item.actions.length > 0
                ? h(
                    'div',
                    { className: 'dcu-actions' },
                    item.actions.map((action, i) =>
                      h(
                        'span',
                        { className: 'dcu-action', key: i, title: action.error || '' },
                        `${action.kind}${action.node_id ? `@${action.node_id}` : ''}${action.status ? ` · ${action.status}` : ''}${action.elapsed_ms ? ` · ${Math.round(action.elapsed_ms)}ms` : ''}`,
                      ),
                    ),
                  )
                : null,
              item.elapsed_ms ? h('div', { className: 'dcu-turn-meta' }, `用时 ${item.elapsed_ms}ms`) : null,
            ),
          ),
    ),
    error ? h('div', { className: 'dcu-error', style: { margin: '0 13px 8px' } }, error) : null,
    h(
      'div',
      { className: 'dcu-router-input' },
      h('textarea', {
        value: draft,
        placeholder: '给 Router 下指令（Enter 发送，Shift+Enter 换行）',
        onChange: (event) => setDraft(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            send()
          }
        },
      }),
      h('button', { className: 'dcu-router-send', onClick: send, disabled: busy || !draft.trim() }, busy ? '发送中…' : '发送'),
    ),
    h('div', { className: 'dcu-hint' }, 'run = 交给 L2 路由挑节点；all = 每个持有该能力的节点各跑一次；on <node> = 指定节点；sync = 触发工作区同步'),
  )
}

/* ------------------------------------------------------------------ 主机 */
function HostCard({ host }) {
  const [open, setOpen] = useState(true)
  const metrics = host.metrics || {}
  return h(
    'article',
    { className: 'dcu-card' },
    h(
      'div',
      { className: 'dcu-card-head' },
      h(Dot, { tone: toneOfNode(host) }),
      h('span', { className: 'dcu-node', title: host.node_id }, host.node_id),
      h('span', { className: 'dcu-chip' }, host.os || '?'),
      host.role === 'router' ? h('span', { className: 'dcu-chip' }, 'router') : null,
      h('span', { className: 'dcu-spacer' }),
      h('button', { className: 'dcu-btn', onClick: () => setOpen(!open) }, open ? `收起 ${host.agent_count}` : `展开 ${host.agent_count}`),
    ),
    h(
      'div',
      { className: 'dcu-metrics' },
      h(Meter, { label: 'CPU', value: metrics.cpu_percent }),
      h(Meter, { label: '内存', value: metrics.mem_percent, detail: `${Math.round(num(metrics.mem_used_mb) || 0)}/${Math.round(num(metrics.mem_total_mb) || 0)}MB` }),
    ),
    h(
      'div',
      { className: 'dcu-kv' },
      h('span', null, '网络 ↓', h('b', null, rateText(metrics.net_in_rate, metrics.net_unit))),
      h('span', null, '↑', h('b', null, rateText(metrics.net_out_rate, metrics.net_unit))),
      h('span', null, 'worker ', h('b', null, `${num(metrics.workers) ?? 0}/${num(metrics.max_workers) ?? '?'}`)),
      h('span', null, '采样 ', h('b', null, agoText(metrics.ts))),
      h('span', null, 'mesh ', h('b', null, host.mesh_ip || '—')),
    ),
    (host.plugin_errors || []).length > 0
      ? h('div', { className: 'dcu-error' }, `插件告警：${host.plugin_errors.slice(0, 3).join('；')}`)
      : null,
    open
      ? h(
          'div',
          { className: 'dcu-agents' },
          host.agents.length === 0
            ? h('div', { className: 'dcu-muted', style: { fontSize: 12 } }, '该节点没有注册 agent')
            : host.agents.map((agent) =>
                h(
                  'div',
                  { className: 'dcu-agent', key: agent.cap_id },
                  h(Dot, { tone: toneOfAgent(agent) }),
                  h('span', { className: 'dcu-agent-id', title: agent.description || agent.cap_id }, agent.cap_id),
                  h('span', { className: 'dcu-muted' }, agent.kind),
                  h('span', { className: 'dcu-muted', title: agent.current_task || '' }, agent.status === 'busy' ? `busy ${agent.current_task || ''}` : agent.status),
                ),
              ),
        )
      : null,
  )
}

function HostsView({ data, error }) {
  if (error && !data) return h('div', { className: 'dcu-error' }, error)
  if (!data) return h('div', { className: 'dcu-muted' }, '读取中…')
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    h(
      'div',
      { className: 'dcu-summary' },
      h('span', { className: 'dcu-chip' }, `节点 ${data.summary.alive}/${data.summary.nodes}`),
      h('span', { className: 'dcu-chip' }, `agents ${data.summary.agents}`),
      h('span', { className: 'dcu-chip' }, `运行中任务 ${data.summary.tasks_running}`),
      h('span', { className: 'dcu-chip', title: data.upstream.control }, `控制面 ${data.upstream.rtt_ms}ms`),
      data.router && data.router.node_id ? h('span', { className: 'dcu-chip' }, `router ${data.router.node_id} · quorum ${data.router.quorum}`) : null,
    ),
    error ? h('div', { className: 'dcu-error' }, error) : null,
    h('div', { className: 'dcu-cards' }, data.items.map((host) => h(HostCard, { key: host.node_id, host }))),
  )
}

/* ------------------------------------------------------------------ 同步 */
function runBadge(status) {
  return h('span', { className: `dcu-badge ${status || ''}` }, status || '?')
}

function SyncView({ onChanged }) {
  const [workspaces, setWorkspaces] = useState([])
  const [nodes, setNodes] = useState([])
  const [runs, setRuns] = useState([])
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [policy, setPolicy] = useState('newest')

  const loadWorkspaces = useCallback(async () => {
    const data = await getJSON('/workspaces')
    setWorkspaces(data.items || [])
    setNodes(data.nodes || [])
    return data.items || []
  }, [])

  const loadRuns = useCallback(async (runId) => {
    const data = await getJSON(runId ? `/workspace/sync/status?run_id=${encodeURIComponent(runId)}` : '/workspace/sync/status')
    if (runId) setSelected(data.run)
    else setRuns(data.runs || [])
    return data
  }, [])

  const refresh = useCallback(async () => {
    try {
      setError(null)
      await loadWorkspaces()
      const data = await loadRuns(selected && selected.id)
      if (!selected && (data.runs || []).length > 0) {
        setSelected(data.runs[0])
      }
    } catch (failure) {
      setError(String(failure.message || failure))
    }
  }, [loadWorkspaces, loadRuns, selected])

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 有跑着的同步就 2 秒一刷
  const active = (selected && selected.status === 'running') || runs.some((run) => run.status === 'running')
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => {
      loadRuns(selected && selected.id).catch(() => {})
    }, 2000)
    return () => clearInterval(timer)
  }, [active, loadRuns, selected])

  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const data = await postJSON('/workspaces', { name: name.trim(), policy, seed: true })
      setName('')
      await loadWorkspaces()
      await loadRuns(data.run.id)
      setSelected(data.run)
      if (onChanged) onChanged()
    } catch (failure) {
      setError(String(failure.message || failure))
    } finally {
      setBusy(false)
    }
  }

  const sync = async (workspaceName) => {
    setBusy(true)
    try {
      const data = await postJSON('/workspace/sync', { workspace: workspaceName })
      await loadRuns(data.run.id)
      setSelected(data.run)
      if (onChanged) onChanged()
    } catch (failure) {
      setError(String(failure.message || failure))
    } finally {
      setBusy(false)
    }
  }

  const retry = async () => {
    if (!selected) return
    setBusy(true)
    try {
      await postJSON('/workspace/sync/retry', { run_id: selected.id })
      await loadRuns(selected.id)
      if (onChanged) onChanged()
    } catch (failure) {
      setError(String(failure.message || failure))
    } finally {
      setBusy(false)
    }
  }

  const workspace = workspaces.find((item) => selected && item.name === selected.workspace)

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    error ? h('div', { className: 'dcu-error' }, error) : null,
    h(
      'div',
      { className: 'dcu-run' },
      h('div', { className: 'dcu-section-title' }, 'cluster 工作区', h('span', { className: 'dcu-muted', style: { fontWeight: 400, fontSize: 12 } }, '（创建后立即同步所有节点）')),
      h(
        'div',
        { className: 'dcu-form' },
        h('input', { className: 'dcu-input', placeholder: '工作区名，如 demo', value: name, onChange: (event) => setName(event.target.value) }),
        h(
          'select',
          { className: 'dcu-select', value: policy, onChange: (event) => setPolicy(event.target.value) },
          h('option', { value: 'newest' }, '冲突策略：最新 mtime 胜出'),
          (nodes || []).map((node) =>
            h('option', { key: node.node_id, value: `prefer:${node.node_id}` }, `冲突策略：优先 ${node.node_id}`),
          ),
        ),
        h('button', { className: 'dcu-btn primary', onClick: create, disabled: busy || !name.trim() }, busy ? '处理中…' : '新建并同步'),
      ),
      workspaces.length === 0
        ? h('div', { className: 'dcu-muted', style: { fontSize: 12 } }, `还没有工作区。节点根目录：${nodes.map((node) => `${node.node_id}=${node.os === 'windows' ? '<cluster 仓库>/.state/workspaces/<name>' : '~/cluster-test/workspaces/<name>'}`).join('，')}`)
        : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            workspaces.map((item) =>
              h(
                'div',
                { key: item.name, style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('b', { style: { fontSize: 12.5 } }, item.name),
                runBadge(item.last_status),
                h('span', { className: 'dcu-muted', style: { fontSize: 11.5 } }, `策略 ${item.policy}`),
                h('span', { className: 'dcu-spacer' }),
                h('button', { className: 'dcu-btn', onClick: () => sync(item.name), disabled: busy }, '同步'),
              ),
            ),
          ),
      workspace && workspace.roots
        ? h(
            'div',
            { className: 'dcu-roots' },
            Object.entries(workspace.roots).map(([nodeId, root]) => h('span', { key: nodeId }, `${nodeId} → ${root}`)),
          )
        : null,
    ),
    runs.length > 0
      ? h(
          'div',
          { className: 'dcu-run' },
          h('div', { className: 'dcu-section-title' }, '最近的同步', h('span', { className: 'dcu-spacer' }), h('button', { className: 'dcu-btn', onClick: refresh }, '刷新')),
          h(
            'div',
            { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            runs.map((run) =>
              h(
                'button',
                {
                  key: run.id,
                  className: 'dcu-btn',
                  style: selected && selected.id === run.id ? { borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' } : undefined,
                  onClick: () => loadRuns(run.id).catch((failure) => setError(String(failure.message || failure))),
                },
                `${run.workspace} · ${run.status} · ${new Date((run.created || 0) * 1000).toLocaleTimeString()}`,
              ),
            ),
          ),
        )
      : null,
    selected
      ? h(
          'div',
          { className: 'dcu-run' },
          h(
            'div',
            { className: 'dcu-run-head' },
            h('b', null, selected.workspace),
            runBadge(selected.status),
            h('span', { className: 'dcu-muted', style: { fontSize: 11.5 } }, `${selected.id} · 第 ${selected.attempt} 次 · 策略 ${selected.policy}`),
            h('span', { className: 'dcu-spacer' }),
            h('span', { className: 'dcu-chip' }, `文件 ${selected.counts.files}`),
            h('span', { className: 'dcu-chip' }, `已一致 ${selected.counts.in_sync}`),
            h('span', { className: 'dcu-chip' }, `复制 ${selected.counts.copied}`),
            h('span', { className: 'dcu-chip' }, `冲突 ${selected.counts.conflicts}`),
            h('span', { className: 'dcu-chip' }, `失败 ${selected.counts.failed}`),
            h('button', { className: 'dcu-btn warn', onClick: retry, disabled: busy || selected.status === 'running' || selected.counts.failed === 0 }, '重试失败项'),
          ),
          selected.error ? h('div', { className: 'dcu-error' }, selected.error) : null,
          h(
            'table',
            { className: 'dcu-table' },
            h('thead', null, h('tr', null, h('th', null, '节点'), h('th', null, '状态'), h('th', null, '清单文件'), h('th', null, '写入'), h('th', null, '错误'))),
            h(
              'tbody',
              null,
              Object.values(selected.nodes || {}).map((node) =>
                h(
                  'tr',
                  { key: node.node_id },
                  h('td', null, node.node_id),
                  h('td', null, node.status),
                  h('td', null, node.manifest_files),
                  h('td', null, node.written),
                  h('td', { className: 'dcu-mono' }, (node.errors || []).slice(0, 2).join('；') || '—'),
                ),
              ),
            ),
          ),
          h(
            'table',
            { className: 'dcu-table' },
            h('thead', null, h('tr', null, h('th', null, '文件'), h('th', null, '结果'), h('th', null, '来源'), h('th', null, '目标'), h('th', null, '错误'))),
            h(
              'tbody',
              null,
              (selected.items || []).map((item) =>
                h(
                  'tr',
                  { key: item.path },
                  h('td', { className: 'dcu-mono' }, item.path),
                  h('td', null, runBadge(item.status)),
                  h('td', null, item.from || '—'),
                  h('td', null, (item.to || []).join(',') || '—'),
                  h('td', { className: 'dcu-mono' }, item.error || '—'),
                ),
              ),
            ),
          ),
          (selected.conflicts || []).length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                h('div', { className: 'dcu-section-title' }, `冲突 ${selected.conflicts.length}`),
                selected.conflicts.map((conflict) =>
                  h(
                    'div',
                    { key: conflict.path, className: 'dcu-mono', style: { fontSize: 11.5 } },
                    `${conflict.path} → 由 ${conflict.winner} 胜出（策略 ${conflict.policy}）`,
                    h('div', { className: 'dcu-muted' }, Object.entries(conflict.sha_by_node || {}).map(([node, sha]) => `${node}:${String(sha).slice(0, 12)}`).join('  ')),
                  ),
                ),
              )
            : null,
          (selected.log || []).length > 0
            ? h('details', null, h('summary', { className: 'dcu-muted', style: { fontSize: 12, cursor: 'pointer' } }, '同步日志'), h('pre', { className: 'dcu-mono', style: { margin: '6px 0 0', whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' } }, selected.log.join('\n')))
            : null,
        )
      : h('div', { className: 'dcu-muted' }, '还没有同步记录：新建一个工作区就会自动跑第一轮。'),
  )
}

/* ------------------------------------------------------------------ 主面板 */
function ClusterPanel() {
  const [tab, setTab] = useState('hosts')
  const [hosts, setHosts] = useState(null)
  const [error, setError] = useState(null)
  const [tick, setTick] = useState(0)

  const loadHosts = useCallback(async () => {
    try {
      const data = await getJSON('/hosts')
      setHosts(data)
      setError(null)
    } catch (failure) {
      setError(String(failure.message || failure))
    }
  }, [])

  useEffect(() => {
    ensureStyle()
    loadHosts()
    const timer = setInterval(loadHosts, 5000)
    return () => clearInterval(timer)
  }, [loadHosts])

  return h(
    'div',
    { className: 'dcu-root' },
    h(
      'header',
      { className: 'dcu-head' },
      h('span', { className: 'dcu-title' }, 'Cluster'),
      h('span', { className: 'dcu-sub' }, hosts ? `${hosts.summary.alive}/${hosts.summary.nodes} 节点 · ${hosts.summary.agents} agents` : '读取中…'),
      h('span', { className: 'dcu-spacer' }),
      h('button', { className: 'dcu-btn', onClick: () => { setTick(tick + 1); loadHosts() } }, '刷新'),
    ),
    h(RouterBox, { onAfter: () => { setTab('hosts'); loadHosts() } }),
    h(
      'div',
      { className: 'dcu-tabs' },
      h('button', { className: 'dcu-tab', 'data-active': String(tab === 'hosts'), onClick: () => setTab('hosts') }, '主机与 agents'),
      h('button', { className: 'dcu-tab', 'data-active': String(tab === 'sync'), onClick: () => setTab('sync') }, '工作区同步'),
    ),
    h('div', { className: 'dcu-body' }, tab === 'hosts' ? h(HostsView, { data: hosts, error }) : h(SyncView, { key: tick, onChanged: loadHosts })),
  )
}

/* ------------------------------------------------------------------ 设置页 */
function ClusterSettings({ close, openPanel }) {
  const [workspaces, setWorkspaces] = useState([])
  const [nodes, setNodes] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [policy, setPolicy] = useState('newest')
  const [created, setCreated] = useState(null)

  const load = useCallback(async () => {
    try {
      const data = await getJSON('/workspaces')
      setWorkspaces(data.items || [])
      setNodes(data.nodes || [])
      setError(null)
    } catch (failure) {
      setError(String(failure.message || failure))
    }
  }, [])

  useEffect(() => {
    ensureStyle()
    load()
  }, [load])

  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const data = await postJSON('/workspaces', { name: name.trim(), policy, seed: true })
      setCreated(data)
      setName('')
      await load()
    } catch (failure) {
      setError(String(failure.message || failure))
    } finally {
      setBusy(false)
    }
  }

  return h(
    'div',
    { className: 'dcu-settings' },
    h('div', { className: 'dcu-section-title' }, 'Cluster 工作区',
      h('span', { className: 'dcu-muted', style: { fontWeight: 400, fontSize: 12 } }, '一个工作区 = 每个节点上一个目录，内容保持一致')),
    h('div', { className: 'dcu-form' }, h('button', { className: 'dcu-btn', onClick: load }, '刷新列表')),
    error ? h('div', { className: 'dcu-error' }, error) : null,
    h(
      'div',
      { className: 'dcu-card' },
      h('div', { className: 'dcu-summary' }, h('span', { className: 'dcu-chip' }, `工作区 ${workspaces.length}`), h('span', { className: 'dcu-chip' }, `在线节点 ${nodes.length}`)),
      h(
        'div',
        { className: 'dcu-form' },
        h('input', { className: 'dcu-input', placeholder: '新工作区名，如 demo', value: name, onChange: (event) => setName(event.target.value) }),
        h(
          'select',
          { className: 'dcu-select', value: policy, onChange: (event) => setPolicy(event.target.value) },
          h('option', { value: 'newest' }, '冲突：最新优先'),
          h('option', { value: 'prefer:win-node' }, '冲突：优先 win-node'),
          h('option', { value: 'prefer:kali-node' }, '冲突：优先 kali-node'),
        ),
        h('button', { className: 'dcu-btn primary', onClick: create, disabled: busy || !name.trim() }, busy ? '创建中…' : '新建并同步'),
        openPanel ? h('button', { className: 'dcu-btn', onClick: () => { if (close) close(); openPanel() } }, '打开 Cluster 面板') : null,
      ),
      created && created.run
        ? h('div', { className: 'dcu-muted', style: { fontSize: 12 } },
            `已创建 ${created.workspace.name}，首轮同步 ${created.run.id} 正在跑：${Object.entries(created.workspace.roots || {}).map(([node, root]) => `${node}→${root}`).join('，')}`)
        : null,
    ),
    workspaces.length === 0
      ? h('div', { className: 'dcu-muted' }, '还没有工作区。')
      : workspaces.map((item) =>
          h(
            'div',
            { key: item.name, className: 'dcu-card' },
            h(
              'div',
              { className: 'dcu-card-head' },
              h('b', { className: 'dcu-node' }, item.name),
              runBadge(item.last_status),
              h('span', { className: 'dcu-spacer' }),
              h('span', { className: 'dcu-muted', style: { fontSize: 11.5 } }, `策略 ${item.policy}`),
            ),
            h('div', { className: 'dcu-roots' }, Object.entries(item.roots || {}).map(([nodeId, root]) => h('span', { key: nodeId }, `${nodeId} → ${root}`))),
            h('div', { className: 'dcu-kv' }, h('span', null, '创建 ', h('b', null, new Date((item.created || 0) * 1000).toLocaleString())), h('span', null, '最近 ', h('b', null, item.last_run || '—'))),
          ),
        ),
  )
}

/* ------------------------------------------------------------------ 图标/注册 */
function ClusterIcon({ size }) {
  return h(
    'svg',
    { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('rect', { x: 1.6, y: 2.2, width: 12.8, height: 4.1, rx: 1.3 }),
    h('rect', { x: 1.6, y: 9.7, width: 12.8, height: 4.1, rx: 1.3 }),
    h('circle', { cx: 4.1, cy: 4.25, r: 0.9, fill: 'currentColor', stroke: 'none' }),
    h('circle', { cx: 4.1, cy: 11.75, r: 0.9, fill: 'currentColor', stroke: 'none' }),
    h('path', { d: 'M7 4.25h5.2M7 11.75h5.2' }),
  )
}

const inject = ['slots', 'layout']

function apply(ctx) {
  ensureStyle()
  const openPanel = () => {
    try {
      ctx.layout.selectPanel(PANEL_ID)
    } catch (error) {
      ctx.logger.warn('dsh-cluster-ui: 无法切到 Cluster 面板: %s', String(error))
    }
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({}) }, () => h(ClusterPanel, {})))
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 12, label: () => 'Cluster' }, ClusterIcon),
  )
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({ name: 'settings.section', id: 'cluster', order: 35, label: () => 'Cluster' }, (props) =>
      h(ClusterSettings, { close: props && props.close, openPanel }),
    ),
  )
}
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})