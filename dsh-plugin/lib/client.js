/**
 * dsh-cluster-ui — 浏览器（client）一侧。
 *
 * 三个落点（对应需求的三条）：
 *   1. `settings.section`  id=cluster          设置页里的「Cluster」：列出集群、新建 cluster 工作区
 *   2. `main` + `sidebar.panellist` key=dsh-cluster-ui
 *                                             主面板「Cluster」：首屏只放状态与图表
 *                                             （健康总览 + 每节点 CPU/内存趋势 + 任务队列 + 同步状态），
 *                                             明细（capability/agent 列表、同步逐文件结果）默认折叠
 *   3. Router 对话框发送消息 -> POST /cluster-ui/api/router/message（服务端转发到 cluster 网关）
 *
 * 说明：这里刻意不引 UI 组件库、不做构建步骤——`lib/client.js` 就是交给
 * dsh-client-modules 加载的成品 bundle（它要求预构建产物）。所有请求都走同源
 * `/cluster-ui/api/*`，由 host 侧代理并附 token。
 *
 * 图表全部是纯 SVG/CSS（折线 + 堆叠条），不引图表库：首屏要的是"一眼看出状态"，
 * 不需要交互式图表那种体积。
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
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h 前`
  return `${Math.round(seconds / 86400)}d 前`
}
function durationText(seconds) {
  const n = num(seconds)
  if (n === null) return '—'
  if (n < 1) return `${Math.round(n * 1000)}ms`
  if (n < 60) return `${n.toFixed(1)}s`
  return `${Math.round(n / 60)}m`
}
/** 运行时长：`238m` 这种要人再除一次才能读，超过 1 小时就给 `3h58m`。 */
function uptimeText(seconds) {
  const n = num(seconds)
  if (n === null || n < 0) return '—'
  if (n < 60) return `${Math.round(n)}s`
  if (n < 3600) return `${Math.round(n / 60)}m`
  const hours = Math.floor(n / 3600)
  const minutes = Math.round((n - hours * 3600) / 60)
  return minutes ? `${hours}h${minutes}m` : `${hours}h`
}
const toneOfNode = (host) => (host.alive ? (num(host.metrics && host.metrics.ts) && Date.now() / 1000 - host.metrics.ts > 30 ? 'warn' : 'ok') : 'bad')
const toneOfAgent = (agent) => (agent.status === 'busy' ? 'busy' : agent.status === 'down' ? 'bad' : 'ok')
const toneOfRun = (status) => (status === 'done' ? 'ok' : status === 'partial' ? 'warn' : status === 'failed' ? 'bad' : status === 'running' ? 'busy' : '')
function kindCounts(agents) {
  const out = {}
  for (const agent of agents || []) {
    const kind = agent.kind || 'other'
    out[kind] = (out[kind] || 0) + 1
  }
  return out
}

/* 历史：服务端采样 + 本地累积合并（服务端旧版本没有 history 时也能有趋势）。 */
function mergeHistory(serverRows, localRows) {
  const rows = []
  const seen = new Set()
  for (const row of [...(serverRows || []), ...(localRows || [])]) {
    if (!row || typeof row.ts !== 'number') continue
    const key = row.ts.toFixed(1)
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(row)
  }
  rows.sort((a, b) => a.ts - b.ts)
  return rows.slice(-60)
}

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
.dcu-chip { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 1px 8px; font-size: 11px; border: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
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

/* 首屏：健康总览条 */
.dcu-strip { display: flex; flex-wrap: wrap; gap: 6px; border: 0.5px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); border-radius: 12px; padding: 8px 10px; }
.dcu-stat { display: flex; align-items: center; gap: 6px; padding: 3px 10px 3px 8px; border-radius: 9px; min-width: 0; }
.dcu-stat + .dcu-stat { border-left: 0.5px solid var(--dsw-alias-border-l2); }
.dcu-stat-label { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dcu-stat-value { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dcu-stat-note { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-left: 2px; }

/* 首屏：图表 */
.dcu-charts { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 12px; }
@media (max-width: 900px) { .dcu-charts { grid-template-columns: 1fr; } }
.dcu-chart { border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 14px; background: var(--dsw-alias-bg-layer-1); padding: 11px 14px 12px; display: flex; flex-direction: column; gap: 9px; min-width: 0; }
.dcu-chart-head { display: flex; align-items: center; gap: 8px; }
.dcu-chart-title { font-size: 12.5px; font-weight: 600; }
.dcu-legend { display: flex; gap: 10px; font-size: 11px; color: var(--dsw-alias-label-tertiary); align-items: center; }
.dcu-legend-swatch { width: 10px; height: 2px; border-radius: 2px; display: inline-block; }
.dcu-spark-row { display: grid; grid-template-columns: 92px minmax(0, 1fr) 96px; gap: 10px; align-items: center; }
.dcu-spark-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcu-spark { width: 100%; height: 30px; display: block; }
.dcu-spark-empty { font-size: 11px; color: var(--dsw-alias-label-tertiary); height: 30px; display: flex; align-items: center; }
.dcu-spark-vals { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
/* 首屏中部：每节点 CPU/内存条形（纯 CSS 宽度编码，不做折线） */
.dcu-bars { display: flex; flex-direction: column; gap: 10px; }
.dcu-bar-node { display: grid; grid-template-columns: 88px minmax(0, 1fr) 132px; gap: 10px; align-items: center; }
.dcu-bar-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcu-bar-pair { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dcu-bar { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 8px; align-items: center; }
.dcu-bar-tag { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
/* 轨道用半透明灰而不是主题的 bg-layer-3：主题皮肤（dream skin）会把那层压到和卡片几乎同色，
   轨道看不见时 0% 和"没数据"就分不出来了。 */
.dcu-bar-track { height: 8px; border-radius: 999px; background: rgba(120, 120, 120, .2); box-shadow: inset 0 0 0 1px rgba(120, 120, 120, .12); overflow: hidden; }
.dcu-bar-fill { display: block; height: 100%; border-radius: 999px; background: #3d7bfd; transition: width .3s ease; }
/* CPU 靛蓝 / 内存琥珀是写死的两个色，不跟主题走：图例的小色块用同一对值，
   保证"图例上的颜色"和"条上的颜色"永远一致（主题变量在这套皮肤下两者同色）。 */
.dcu-bar-fill.mem { background: #d98a2b; }
.dcu-bar-fill.bad { background: var(--dsw-alias-state-error-primary); }
.dcu-bar-vals { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
@media (max-width: 640px) { .dcu-bar-node { grid-template-columns: minmax(0, 1fr); gap: 4px; } .dcu-bar-vals { text-align: left; } }
@media (prefers-reduced-motion: reduce) { .dcu-bar-fill { transition: none; } }

.dcu-qbar { display: flex; height: 12px; border-radius: 999px; overflow: hidden; background: var(--dsw-alias-bg-layer-3); }
.dcu-qseg { height: 100%; }
.dcu-qseg.waiting { background: var(--dsw-alias-state-warn-primary); opacity: .55; }
.dcu-qseg.running { background: var(--dsw-alias-brand-primary); }
.dcu-qseg.done { background: var(--dsw-alias-state-success-primary); opacity: .8; }
.dcu-qseg.failed { background: var(--dsw-alias-state-error-primary); }
.dcu-qseg.cancelled, .dcu-qseg.unknown { background: var(--dsw-alias-label-tertiary); opacity: .4; }
.dcu-qkeys { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dcu-qkey { display: inline-flex; align-items: center; gap: 5px; }
.dcu-qkey b { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.dcu-qkey .dcu-dot { width: 8px; height: 8px; border-radius: 3px; }

/* 主机卡 */
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

/* 折叠：明细默认收起 */
.dcu-fold { border-top: 0.5px dashed var(--dsw-alias-border-l3); padding-top: 8px; }
.dcu-fold > summary { cursor: pointer; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); list-style: none; display: flex; align-items: center; gap: 6px; }
.dcu-fold > summary::-webkit-details-marker { display: none; }
.dcu-fold > summary::before { content: '▸'; font-size: 10px; color: var(--dsw-alias-label-tertiary); transition: transform .12s ease; }
.dcu-fold[open] > summary::before { transform: rotate(90deg); }
.dcu-fold > summary:hover { color: var(--dsw-alias-label-secondary); }
.dcu-agents { display: flex; flex-direction: column; gap: 3px; padding-top: 8px; }
.dcu-agent { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto auto; gap: 8px; align-items: center; font-size: 12px; }
.dcu-agent-id { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcu-muted { color: var(--dsw-alias-label-tertiary); }

/* Router 对话框：深色板 + 琥珀描边，刻意和普通会话的浅色输入框拉开距离 */
.dcu-router { margin: 0 18px 12px; border-radius: 14px; border: 1px solid rgba(201, 139, 58, .75); background: linear-gradient(180deg, #241a11 0%, #161210 100%); color: #f4e8d6; box-shadow: 0 10px 26px rgba(0, 0, 0, .18); display: flex; flex-direction: column; min-height: 0; }
.dcu-router.collapsed { padding-bottom: 2px; }
.dcu-router-head { display: flex; align-items: center; gap: 8px; padding: 9px 13px 7px; border-bottom: 1px solid rgba(201, 139, 58, .35); }
.dcu-router-title { font-size: 12.5px; font-weight: 700; letter-spacing: .6px; color: #f0c07a; text-transform: uppercase; }
.dcu-router-tag { font-size: 11px; color: rgba(244, 232, 214, .62); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
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
.dcu-fold > summary.dcu-sync-row { display: grid; grid-template-columns: minmax(90px, 1.1fr) auto minmax(0, 1fr) auto; gap: 10px; align-items: center; font-size: 12px; padding: 5px 0 5px 14px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); position: relative; }
/* 折叠箭头绝对定位：summary 是 grid 容器，::before 若参与布局会挤掉第一列。 */
.dcu-fold > summary.dcu-sync-row::before { position: absolute; left: 0; top: 50%; transform: translateY(-50%); }
.dcu-fold[open] > summary.dcu-sync-row::before { transform: translateY(-50%) rotate(90deg); }
.dcu-sync-row:last-of-type { border-bottom: 0; }
.dcu-sync-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcu-sync-note { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

function Meter({ label, value, detail }) {
  const n = num(value)
  const level = n === null ? '' : n >= 90 ? 'bad' : n >= 75 ? 'warn' : ''
  return h(
    'div',
    { className: 'dcu-meter' },
    h('div', { className: 'dcu-meter-head' }, h('span', null, label), h('span', null, detail || percent(value))),
    h('div', { className: 'dcu-meter-track' }, h('div', { className: `dcu-meter-fill ${level}`, style: { width: `${n === null ? 0 : Math.max(0, Math.min(100, n))}%` } })),
  )
}

/**
 * 迷你趋势线：纯 SVG，两条折线（CPU / 内存），固定 0–100% 纵轴。
 *
 * 为什么固定刻度而不是自适应：自适应会让 0.3% 的平坦曲线看起来像剧烈波动，
 * 那种"信息"是假的。固定刻度下平就是平，需要精确值就看右边的数字。
 */
function Spark({ points, width = 120, height = 30 }) {
  const rows = (points || []).filter((row) => num(row.cpu) !== null || num(row.mem) !== null)
  if (rows.length === 0) return h('div', { className: 'dcu-spark-empty' }, '采样中…')
  // 上下各留 3px：低负载（<5%）时折线会贴到基线上，和坐标轴糊成一条黑线，看不出"在动"。
  const PAD = 3
  const x = (index) => (rows.length === 1 ? width / 2 : (index / (rows.length - 1)) * width)
  const y = (value) => height - PAD - (Math.max(0, Math.min(100, value)) / 100) * (height - PAD * 2)
  const path = (key) => {
    let out = ''
    let started = false
    rows.forEach((row, index) => {
      const value = num(row[key])
      if (value === null) {
        started = false
        return
      }
      out += `${started ? 'L' : 'M'}${x(index).toFixed(2)} ${y(value).toFixed(2)} `
      started = true
    })
    return out.trim()
  }
  /** 折线下方的淡填充：一条贴底的细线看不出趋势，有了面积块才能判断"一直很低"还是"掉下来了"。 */
  const area = (key) => {
    const line = path(key)
    if (!line) return ''
    const first = rows.findIndex((row) => num(row[key]) !== null)
    const last = rows.length - 1 - [...rows].reverse().findIndex((row) => num(row[key]) !== null)
    return `${line} L${x(last).toFixed(2)} ${height} L${x(first).toFixed(2)} ${height} Z`
  }
  const lastCpu = [...rows].reverse().map((row) => num(row.cpu)).find((value) => value !== null)
  const cpuPath = path('cpu')
  const memPath = path('mem')
  const cpuArea = area('cpu')
  const memArea = area('mem')
  const lastIndex = rows.length - 1
  const dotAt = (value) =>
    num(value) === null ? null : h('circle', { cx: x(lastIndex), cy: y(value), r: 1.8, fill: 'currentColor', stroke: 'none' })
  return h(
    'svg',
    { className: 'dcu-spark', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'CPU 与内存趋势' },
    h('line', { x1: 0, y1: height - 1, x2: width, y2: height - 1, stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 0.5, vectorEffect: 'non-scaling-stroke' }),
    h('line', { x1: 0, y1: height / 2, x2: width, y2: height / 2, stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 0.5, strokeDasharray: '2 2', vectorEffect: 'non-scaling-stroke' }),
    memArea ? h('path', { d: memArea, fill: '#d98a2b', opacity: 0.16, stroke: 'none' }) : null,
    cpuArea ? h('path', { d: cpuArea, fill: '#3d7bfd', opacity: 0.16, stroke: 'none' }) : null,
    memPath ? h('path', { d: memPath, fill: 'none', stroke: '#d98a2b', strokeWidth: 1.2, vectorEffect: 'non-scaling-stroke', opacity: 0.95 }) : null,
    cpuPath ? h('path', { d: cpuPath, fill: 'none', stroke: '#3d7bfd', strokeWidth: 1.4, vectorEffect: 'non-scaling-stroke' }) : null,
    h('g', { style: { color: '#3d7bfd' } }, dotAt(lastCpu)),
  )
}

/* ------------------------------------------------------------------ 首屏：健康总览 */
function Stat({ tone, label, value, note, title }) {
  return h(
    'div',
    { className: 'dcu-stat', title },
    tone ? h(Dot, { tone }) : null,
    h('span', { className: 'dcu-stat-label' }, label),
    h('span', { className: 'dcu-stat-value' }, value),
    note ? h('span', { className: 'dcu-stat-note' }, note) : null,
  )
}

/** 冲突策略的对外文字：接口里是 `newest` / `prefer:<node>`。 */
function policyText(policy) {
  const value = String(policy || '')
  if (!value) return '—'
  if (value === 'newest') return '最新优先'
  if (value.startsWith('prefer:')) return `优先 ${value.slice(7)}`
  return value
}

/** 同步状态的对外文字：首屏是给人扫的，英文枚举只在明细里出现。 */
const SYNC_TEXT = { done: '完成', partial: '部分', failed: '失败', running: '运行中', queued: '排队' }
const syncText = (status) => (status ? SYNC_TEXT[status] || status : '无记录')

function HealthStrip({ data }) {
  const summary = (data && data.summary) || {}
  const queue = (data && data.queue) || { counts: {}, total: 0 }
  const counts = queue.counts || {}
  const workspaces = (data && data.workspaces) || []
  // 顶栏这一格回答"最近一次同步成没成"，所以取 finished/created 最新的那轮，而不是各工作区最差档：
  // 后者在"老工作区 failed、新工作区刚 done"时会一直挂着一个红点，人看着像是当前有问题。
  const latestSync = workspaces
    .filter((item) => item && item.last)
    .slice()
    .sort((a, b) => (b.last.finished || b.last.created || 0) - (a.last.finished || a.last.created || 0))[0]
  const syncStatus = latestSync ? latestSync.last.status || latestSync.last_status : null
  const nodes = num(summary.nodes) ?? 0
  const alive = num(summary.alive) ?? 0
  const peers = (data && data.peers) || []
  const quorum = num(data && data.quorum)
  const rtt = num(data && data.upstream && data.upstream.rtt_ms)
  const nodeTone = nodes === 0 ? 'bad' : alive === nodes ? 'ok' : alive > 0 ? 'warn' : 'bad'
  const quorumOk = quorum === null ? null : peers.length + 1 >= quorum
  const waiting = (counts.waiting || 0) + (counts.pending || 0)
  const running = (counts.running || 0) + (counts.claimed || 0)
  const failed = counts.failed || 0
  const taskTone = failed > 0 ? 'warn' : running > 0 ? 'busy' : 'ok'
  const syncTone = syncStatus === null ? '' : toneOfRun(syncStatus)
  const rttTone = rtt === null ? '' : rtt < 300 ? 'ok' : rtt < 1500 ? 'warn' : 'bad'
  return h(
    'div',
    { className: 'dcu-strip' },
    h(Stat, { tone: nodeTone, label: '节点', value: `${alive}/${nodes}`, note: alive === nodes ? '全部在线' : '有节点离线', title: '来自 /api/hosts 的 summary.alive / summary.nodes' }),
    h(Stat, {
      tone: quorumOk === null ? '' : quorumOk ? 'ok' : 'bad',
      label: 'quorum',
      value: quorum === null ? '—' : `${quorum}`,
      note: peers.length ? `· ${peers.length + 1} 副本` : '· 单副本',
      title: '控制面 quorum 与对等副本数',
    }),
    h(Stat, { tone: taskTone, label: '任务', value: `${running} 运行`, note: `· 排队 ${waiting}${failed ? ` · 失败 ${failed}` : ''}`, title: '任务队列分桶（pending/queued 归入排队，claimed/running 归入运行）' }),
    h(Stat, {
      tone: syncTone,
      label: '同步',
      value: syncText(syncStatus),
      note: workspaces.length ? `· 最近一轮 · ${workspaces.length} 个工作区` : '· 还没有工作区',
      title: '最近完成的那一轮同步的 status（done/partial/failed）；逐工作区的结果与冲突数见下方「同步状态」',
    }),
    h(Stat, { tone: rttTone, label: '控制面', value: rtt === null ? '—' : `${Math.round(rtt)}ms`, note: '· 往返', title: '网关到控制面的一次快照耗时' }),
  )
}

/* ------------------------------------------------------------------ 首屏：图表 */
/**
 * 每节点 CPU / 内存条形。
 *
 * 为什么用条形而不是折线：首屏的问题是「现在谁吃满了」，条形把当前值直接映射成
 * 长度，横向一列就能扫完两台机；折线回答的是「过去怎么变的」，那是第二屏的事。
 * 宽度用 CSS 百分比，不画 SVG——没有坐标轴要对齐，SVG 只会多一层 viewBox 缩放误差。
 */
function ResourceBars({ hosts }) {
  if (hosts.length === 0) {
    return h('section', { className: 'dcu-chart', 'aria-label': '节点资源' }, h('div', { className: 'dcu-chart-head' }, h('span', { className: 'dcu-chart-title' }, '节点资源')), h('div', { className: 'dcu-muted', style: { fontSize: 12 } }, '还没有节点数据。'))
  }
  return h(
    'section',
    { className: 'dcu-chart', 'aria-label': '节点资源' },
    h(
      'div',
      { className: 'dcu-chart-head' },
      h('span', { className: 'dcu-chart-title' }, '节点资源'),
      h('span', { className: 'dcu-spacer' }),
      h(
        'div',
        { className: 'dcu-legend' },
        h('span', null, h('span', { className: 'dcu-legend-swatch', style: { background: '#3d7bfd' } }), ' CPU'),
        h('span', null, h('span', { className: 'dcu-legend-swatch', style: { background: '#d98a2b' } }), ' 内存'),
      ),
    ),
    h(
      'div',
      { className: 'dcu-bars' },
      hosts.map((host) => {
        const metrics = host.metrics || {}
        const cpu = num(metrics.cpu_percent)
        const mem = num(metrics.mem_percent)
        const fill = (value, cls) =>
          h('div', { className: 'dcu-bar-track' }, h('span', { className: `dcu-bar-fill ${cls}${value !== null && value >= 90 ? ' bad' : ''}`, style: { width: `${value === null ? 0 : Math.max(0, Math.min(100, value))}%` } }))
        return h(
          'div',
          { className: 'dcu-bar-node', key: host.node_id },
          h('span', { className: 'dcu-bar-name', title: host.node_id }, host.node_id),
          h(
            'div',
            { className: 'dcu-bar-pair' },
            h('div', { className: 'dcu-bar', title: `CPU ${percent(cpu)}` }, h('span', { className: 'dcu-bar-tag' }, 'CPU'), fill(cpu, '')),
            h('div', { className: 'dcu-bar', title: `内存 ${percent(mem)}` }, h('span', { className: 'dcu-bar-tag' }, '内存'), fill(mem, 'mem')),
          ),
          h(
            'span',
            { className: 'dcu-bar-vals' },
            `${percent(cpu)} · ${percent(mem)}`,
            num(metrics.cpu_count) ? h('span', { className: 'dcu-muted' }, ` / ${metrics.cpu_count} 核`) : null,
          ),
        )
      }),
    ),
    h('div', { className: 'dcu-muted', style: { fontSize: 11 } }, '刻度 0–100%；内存条转红 = 已达 90%。数值取自 GET /api/hosts 的 metrics。'),
  )
}

function QueueCard({ queue }) {
  const counts = (queue && queue.counts) || {}
  const total = num(queue && queue.total) ?? 0
  const [recent, setRecent] = useState(null)
  const [loading, setLoading] = useState(false)
  const parts = [
    ['waiting', '排队'],
    ['running', '运行中'],
    ['done', '完成'],
    ['failed', '失败'],
    ['cancelled', '取消'],
  ]
  const other = (counts.unknown || 0)

  // 最近任务按需拉：首屏不多打一次请求，展开才取。
  const loadRecent = async () => {
    if (recent || loading) return
    setLoading(true)
    try {
      const data = await getJSON('/tasks?limit=10')
      setRecent((data.items || []).slice().reverse())
    } catch (failure) {
      setRecent([{ id: `读取失败: ${String(failure.message || failure)}` }])
    } finally {
      setLoading(false)
    }
  }

  return h(
    'section',
    { className: 'dcu-chart', 'aria-label': '任务队列' },
    h('div', { className: 'dcu-chart-head' }, h('span', { className: 'dcu-chart-title' }, '任务队列'), h('span', { className: 'dcu-spacer' }), h('span', { className: 'dcu-muted', style: { fontSize: 11 } }, `共 ${total}`)),
    total === 0
      ? h('div', { className: 'dcu-muted', style: { fontSize: 12 } }, '还没有任务：在 Router 里下一条指令就会出现在这里。')
      : h(
          'div',
          { className: 'dcu-qbar', title: parts.map(([key, label]) => `${label} ${counts[key] || 0}`).join(' · ') },
          parts
            .filter(([key]) => (counts[key] || 0) > 0)
            .map(([key]) => h('div', { key, className: `dcu-qseg ${key}`, style: { width: `${((counts[key] || 0) / total) * 100}%` } })),
          other > 0 ? h('div', { className: 'dcu-qseg unknown', style: { width: `${(other / total) * 100}%` } }) : null,
        ),
    h(
      'div',
      { className: 'dcu-qkeys' },
      parts.map(([key, label]) =>
        h('span', { className: 'dcu-qkey', key }, h('span', { className: `dcu-dot ${key === 'done' ? 'ok' : key === 'failed' ? 'bad' : key === 'waiting' ? 'warn' : key === 'running' ? 'busy' : ''}`, style: { background: key === 'cancelled' ? 'var(--dsw-alias-label-tertiary)' : undefined } }), label, h('b', null, counts[key] || 0)),
      ),
    ),
    total > 0
      ? h(
          'details',
          { className: 'dcu-fold', onToggle: (event) => { if (event.currentTarget.open) loadRecent() } },
          h('summary', null, '最近任务'),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 3, paddingTop: 6 } },
            loading && !recent ? h('div', { className: 'dcu-muted', style: { fontSize: 11.5 } }, '读取中…') : null,
            (recent || []).map((task, index) =>
              h(
                'div',
                { className: 'dcu-agent', key: task.id || index, style: { gridTemplateColumns: '10px minmax(0, 1fr) auto' } },
                h(Dot, { tone: task.status === 'done' ? 'ok' : task.status === 'failed' ? 'bad' : task.status === 'running' || task.status === 'claimed' ? 'busy' : 'warn' }),
                h('span', { className: 'dcu-agent-id', title: task.cap_id || '' }, `${task.id || '—'}${task.cap_id ? ` · ${task.cap_id}` : ''}`),
                h('span', { className: 'dcu-muted' }, `${task.node_id || '—'} · ${task.status || '?'}`),
              ),
            ),
          ),
        )
      : null,
  )
}

/* ------------------------------------------------------------------ 主机卡（明细折叠） */
function HostCard({ host }) {
  const metrics = host.metrics || {}
  const agents = host.agents || []
  const kinds = kindCounts(agents)
  const kindText = Object.entries(kinds)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(' · ')
  const workers = num(metrics.workers)
  const maxWorkers = num(metrics.max_workers)
  return h(
    'article',
    { className: 'dcu-card' },
    // 卡面只留「这台机是谁、现在多忙、带多少活」：主机名 / OS / CPU / 内存 / worker / 能力数。
    // mesh IP、网卡速率、采样点、agent 逐个状态都属于明细，默认收在下面的 details 里。
    h(
      'div',
      { className: 'dcu-card-head' },
      h(Dot, { tone: toneOfNode(host) }),
      h('span', { className: 'dcu-node', title: host.node_id }, host.node_id),
      h('span', { className: 'dcu-chip' }, host.os || '?'),
      host.role === 'router' ? h('span', { className: 'dcu-chip' }, 'router') : null,
      h('span', { className: 'dcu-spacer' }),
      h('span', { className: 'dcu-muted', style: { fontSize: 11 } }, `更新 ${agoText(metrics.ts)}`),
    ),
    h(
      'div',
      { className: 'dcu-metrics' },
      h(Meter, { label: 'CPU', value: metrics.cpu_percent, detail: num(metrics.cpu_count) ? `${percent(metrics.cpu_percent)} · ${metrics.cpu_count} 核` : percent(metrics.cpu_percent) }),
      h(Meter, {
        label: '内存',
        value: metrics.mem_percent,
        detail: num(metrics.mem_used_mb) ? `${Math.round(metrics.mem_used_mb)}/${Math.round(num(metrics.mem_total_mb) || 0)}MB` : percent(metrics.mem_percent),
      }),
    ),
    h(
      'div',
      { className: 'dcu-kv' },
      h('span', null, 'worker ', h('b', null, workers === null ? '—' : `${workers}/${maxWorkers ?? '?'}`)),
      h('span', null, '能力 ', h('b', null, agents.length)),
      (host.task_counts && (host.task_counts.running || host.task_counts.failed))
        ? h('span', null, '任务 ', h('b', null, `${host.task_counts.running || 0} 运行`), host.task_counts.failed ? ` · ${host.task_counts.failed} 失败` : '')
        : null,
    ),
    (host.plugin_errors || []).length > 0
      ? h('div', { className: 'dcu-error' }, `插件告警：${host.plugin_errors.slice(0, 3).join('；')}`)
      : null,
    h(
      'details',
      { className: 'dcu-fold' },
      h('summary', null, `明细 · 网络 / 趋势 / 能力 ${agents.length} 条`),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8 } },
        h(
          'div',
          { className: 'dcu-kv' },
          h('span', null, 'mesh ', h('b', null, host.mesh_ip || '—')),
          h('span', null, '网络 ↓ ', h('b', null, rateText(metrics.net_in_rate, metrics.net_unit)), ' ↑ ', h('b', null, rateText(metrics.net_out_rate, metrics.net_unit))),
          num(metrics.uptime_s) ? h('span', null, '已运行 ', h('b', null, uptimeText(metrics.uptime_s))) : null,
        ),
        kindText ? h('div', { className: 'dcu-muted', style: { fontSize: 11 } }, kindText) : null,
        h('div', { className: 'dcu-bar-tag', style: { marginTop: 2 } }, 'CPU / 内存 最近采样'),
        h(Spark, { points: host.history || [], height: 34 }),
        h(
          'div',
          { className: 'dcu-agents' },
          agents.length === 0
            ? h('div', { className: 'dcu-muted', style: { fontSize: 12 } }, '该节点没有注册能力')
            : agents.map((agent) =>
                h(
                  'div',
                  { className: 'dcu-agent', key: agent.cap_id },
                  h(Dot, { tone: toneOfAgent(agent) }),
                  h('span', { className: 'dcu-agent-id', title: agent.description || agent.cap_id }, agent.cap_id),
                  h('span', { className: 'dcu-muted' }, agent.kind),
                  h('span', { className: 'dcu-muted', title: agent.current_task || '' }, agent.status === 'busy' ? `busy ${agent.current_task || ''}` : agent.status),
                ),
              ),
        ),
      ),
    ),
  )
}

/* ------------------------------------------------------------------ 首屏：同步摘要（折叠） */
function SyncSummary({ workspaces }) {
  if (!workspaces || workspaces.length === 0) {
    return h('div', { className: 'dcu-run' }, h('div', { className: 'dcu-section-title' }, '同步'), h('div', { className: 'dcu-muted', style: { fontSize: 12 } }, '还没有工作区：在「同步」页或设置页新建一个。'))
  }
  return h(
    'div',
    { className: 'dcu-run' },
    h('div', { className: 'dcu-section-title' }, '同步状态', h('span', { className: 'dcu-muted', style: { fontWeight: 400, fontSize: 12 } }, '（每个工作区最近一轮）')),
    workspaces.map((item) => {
      const last = item.last || {}
      const counts = last.counts || {}
      const status = item.last_status || last.status || null
      const conflicts = num(counts.conflicts) ?? 0
      const failed = num(counts.failed) ?? 0
      const note = [
        counts.files ? `文件 ${counts.files}` : null,
        `复制 ${counts.copied ?? 0}`,
        failed ? `失败 ${failed}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
      return h(
        'details',
        { className: 'dcu-fold', key: item.name },
        h(
          'summary',
          { className: 'dcu-sync-row', style: { listStyle: 'none' } },
          h('span', { className: 'dcu-sync-name' }, item.name),
          h('span', null, status ? h('span', { className: `dcu-badge ${status}` }, syncText(status)) : h('span', { className: 'dcu-muted', style: { fontSize: 11 } }, '未同步')),
          h(
            'span',
            { className: 'dcu-sync-note' },
            conflicts > 0
              ? h('span', { className: 'dcu-badge conflict' }, `冲突 ${conflicts}`)
              : h('span', { className: 'dcu-muted' }, '无冲突'),
            note ? `  ${note}` : '',
          ),
          h('span', { className: 'dcu-muted', style: { fontSize: 11 } }, last.finished ? agoText(last.finished) : '—'),
        ),
        h(
          'div',
          { style: { paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', { className: 'dcu-muted', style: { fontSize: 11 } }, `${last.id || '—'} · 策略 ${last.policy || item.policy || '—'} · 第 ${last.attempt || 1} 次 · 状态 ${syncText(status)}`),
          (last.nodes || []).length === 0
            ? h('div', { className: 'dcu-muted', style: { fontSize: 11.5 } }, '没有节点级记录')
            : (last.nodes || []).map((node) =>
                h(
                  'div',
                  { className: 'dcu-sync-note', key: node.node_id },
                  `${node.node_id} · ${syncText(node.status)} · 清单 ${node.manifest_files ?? '—'} · 写入 ${node.written ?? '—'}${(node.errors || []).length ? ` · ${(node.errors || []).join('；')}` : ''}`,
                ),
              ),
        ),
      )
    }),
  )
}

/* ------------------------------------------------------------------ 总览 */
function Overview({ data, error, history }) {
  if (error && !data) return h('div', { className: 'dcu-error' }, error)
  if (!data) return h('div', { className: 'dcu-muted' }, '读取中…')
  const hosts = (data.items || []).map((host) => ({ ...host, history: mergeHistory(host.history, history[host.node_id]) }))
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    h(HealthStrip, { data }),
    error ? h('div', { className: 'dcu-error' }, error) : null,
    h('div', { className: 'dcu-charts' }, h(ResourceBars, { hosts }), h(QueueCard, { queue: data.queue })),
    h(SyncSummary, { workspaces: data.workspaces }),
    h('div', { className: 'dcu-section-title' }, '节点', h('span', { className: 'dcu-muted', style: { fontWeight: 400, fontSize: 12 } }, '（明细默认折叠）')),
    hosts.length === 0
      ? h('div', { className: 'dcu-muted' }, '没有节点被注册。')
      : h('div', { className: 'dcu-cards' }, hosts.map((host) => h(HostCard, { key: host.node_id, host }))),
  )
}

/* ------------------------------------------------------------------ Router */
function RouterBox({ onAfter }) {
  const [items, setItems] = useState([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // 首屏只放状态与图表，所以 Router 默认收起；标题栏保留入口 + 一句摘要。
  const [collapsed, setCollapsed] = useState(true)
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

  const tokens = (item) => {
    const usage = item && item.usage
    if (!usage) return null
    const input = num(usage.inputTokens)
    const output = num(usage.outputTokens)
    if (input === null && output === null) return null
    return `in ${input ?? 0} / out ${output ?? 0} tokens`
  }

  // 收起时的一句话摘要：轮数 + 最后一轮谁说的 + 第一行（多行输出压成一行并截断）。
  const lastItem = items.length ? items[items.length - 1] : null
  const firstLine = lastItem
    ? String(lastItem.text || '')
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) || ''
    : ''
  const lastLine = lastItem
    ? `${items.length} 轮 · ${lastItem.role === 'user' ? '你' : 'Router'}：${firstLine.replace(/\s+/g, ' ').slice(0, 44)}${firstLine.length > 44 ? '…' : ''}`
    : '点右侧展开对话'

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
      className: `dcu-router${collapsed ? ' collapsed' : ''}`,
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
      h('span', { className: 'dcu-router-tag' }, collapsed ? lastLine : '真实 LLM 会话 · 只会调 cluster_* 工具（没有 shell）'),
      h('span', { className: 'dcu-spacer' }),
      h('button', { className: 'dcu-btn', style: { background: 'transparent', color: '#f0c07a', borderColor: 'rgba(201,139,58,.45)' }, onClick: () => setCollapsed(!collapsed) }, collapsed ? '展开对话' : '收起'),
      collapsed ? null : h('button', { className: 'dcu-btn', style: { background: 'transparent', color: '#f0c07a', borderColor: 'rgba(201,139,58,.45)' }, onClick: load, disabled: busy }, '刷新记录'),
    ),
    collapsed
      ? null
      : h(
          'div',
          { className: 'dcu-router-log', ref: logRef },
          items.length === 0
            ? h('div', { className: 'dcu-turn-meta' }, '直接说话就走模型（kali 现在负载怎么样 / 在 kali 上跑 skill:uppercase，文本 hello）；命令走规则、不调模型（status / hosts / all skill:uppercase@1.0.0 {"text":"hi"}）')
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
                            {
                              className: 'dcu-action',
                              key: i,
                              // 悬停看参数与结果：LLM 的工具调用把 args/result 一起带过来了。
                              title: [action.error, action.args ? `args ${typeof action.args === 'string' ? action.args : JSON.stringify(action.args)}` : '', action.result ? `→ ${action.result}` : '']
                                .filter(Boolean)
                                .join('\n'),
                            },
                            action.kind === 'tool'
                              ? `${action.name || 'tool'} · ${action.status}${action.elapsed_ms ? ` · ${Math.round(action.elapsed_ms)}ms` : ''}`
                              : `${action.kind}${action.node_id ? `@${action.node_id}` : ''}${action.status ? ` · ${action.status}` : ''}${action.elapsed_ms ? ` · ${Math.round(action.elapsed_ms)}ms` : ''}`,
                          ),
                        ),
                      )
                    : null,
                  item.elapsed_ms || tokens(item)
                    ? h(
                        'div',
                        { className: 'dcu-turn-meta' },
                        [
                          item.elapsed_ms ? `${item.source === 'llm' ? `LLM${item.model ? ` · ${item.model}` : ''} · ` : '规则 · '}用时 ${Math.round(item.elapsed_ms)}ms` : null,
                          tokens(item),
                        ]
                          .filter(Boolean)
                          .join(' · '),
                      )
                    : null,
                ),
              ),
        ),
    collapsed ? null : error ? h('div', { className: 'dcu-error', style: { margin: '0 13px 8px' } }, error) : null,
    collapsed
      ? null
      : h(
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
    collapsed ? null : h('div', { className: 'dcu-hint' }, 'run = 交给 L2 路由挑节点；all = 每个持有该能力的节点各跑一次；on <node> = 指定节点；sync = 触发工作区同步'),
  )
}

/* ------------------------------------------------------------------ 同步（详细管理页） */
function runBadge(status) {
  // 英文枚举只留在接口里；界面上统一成中文，否则同一列里「完成」和 done 混着读。
  return h('span', { className: `dcu-badge ${status || ''}` }, syncText(status))
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
            h('span', { className: 'dcu-muted', style: { fontSize: 11.5 } }, `${selected.id} · 第 ${selected.attempt} 次 · 策略 ${selected.policy} · 耗时 ${durationText((selected.finished || selected.updated || 0) - (selected.created || 0))}`),
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
            'details',
            { className: 'dcu-fold' },
            h('summary', null, `逐节点结果 ${Object.keys(selected.nodes || {}).length}`),
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
          ),
          h(
            'details',
            { className: 'dcu-fold' },
            h('summary', null, `逐文件结果 ${(selected.items || []).length}`),
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
          ),
          (selected.conflicts || []).length > 0
            ? h(
                'details',
                { className: 'dcu-fold' },
                h('summary', null, `冲突 ${selected.conflicts.length}`),
                selected.conflicts.map((conflict) =>
                  h(
                    'div',
                    { key: conflict.path, className: 'dcu-mono', style: { fontSize: 11.5, paddingTop: 6 } },
                    `${conflict.path} → 由 ${conflict.winner} 胜出（策略 ${conflict.policy}）`,
                    h('div', { className: 'dcu-muted' }, Object.entries(conflict.sha_by_node || {}).map(([node, sha]) => `${node}:${String(sha).slice(0, 12)}`).join('  ')),
                  ),
                ),
              )
            : null,
          (selected.log || []).length > 0
            ? h('details', { className: 'dcu-fold' }, h('summary', null, '同步日志'), h('pre', { className: 'dcu-mono', style: { margin: '6px 0 0', whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' } }, selected.log.join('\n')))
            : null,
        )
      : h('div', { className: 'dcu-muted' }, '还没有同步记录：新建一个工作区就会自动跑第一轮。'),
  )
}

/* ------------------------------------------------------------------ 主面板 */
function ClusterPanel() {
  const [tab, setTab] = useState('overview')
  const [hosts, setHosts] = useState(null)
  const [error, setError] = useState(null)
  const [tick, setTick] = useState(0)
  // 本地累积的历史：服务端旧版本没有 history 字段时，客户端自己也能攒出趋势。
  const localHistory = useRef({})

  const loadHosts = useCallback(async () => {
    try {
      const data = await getJSON('/hosts')
      for (const host of data.items || []) {
        const metrics = host.metrics || {}
        const row = { ts: num(metrics.ts) || Date.now() / 1000, cpu: num(metrics.cpu_percent), mem: num(metrics.mem_percent) }
        if (row.cpu === null && row.mem === null) continue
        const series = localHistory.current[host.node_id] || (localHistory.current[host.node_id] = [])
        if (!series.length || Math.abs(series[series.length - 1].ts - row.ts) >= 1) series.push(row)
        if (series.length > 60) series.splice(0, series.length - 60)
      }
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
      h('span', { className: 'dcu-sub' }, hosts ? `${(hosts.summary || {}).alive ?? '—'}/${(hosts.summary || {}).nodes ?? '—'} 节点 · ${(hosts.summary || {}).agents ?? '—'} 能力 · 每 5s 刷新` : '读取中…'),
      h('span', { className: 'dcu-spacer' }),
      h('button', { className: 'dcu-btn', onClick: () => { setTick(tick + 1); loadHosts() } }, '刷新'),
    ),
    h(RouterBox, { onAfter: () => { setTab('overview'); loadHosts() } }),
    h(
      'div',
      { className: 'dcu-tabs' },
      h('button', { className: 'dcu-tab', 'data-active': String(tab === 'overview'), onClick: () => setTab('overview') }, '总览'),
      h('button', { className: 'dcu-tab', 'data-active': String(tab === 'sync'), onClick: () => setTab('sync') }, '工作区同步'),
    ),
    h('div', { className: 'dcu-body' }, tab === 'overview' ? h(Overview, { data: hosts, error, history: localHistory.current }) : h(SyncView, { key: tick, onChanged: loadHosts })),
  )
}

/* ------------------------------------------------------------------ 设置页 */
function ClusterSettings({ close, openPanel }) {
  const [workspaces, setWorkspaces] = useState([])
  const [nodes, setNodes] = useState([])
  const [health, setHealth] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [policy, setPolicy] = useState('newest')
  const [created, setCreated] = useState(null)

  const load = useCallback(async () => {
    try {
      const [data, info] = await Promise.all([getJSON('/workspaces'), getJSON('/health').catch(() => null)])
      setWorkspaces(data.items || [])
      setNodes(data.nodes || [])
      if (info) setHealth(info)
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
      // 一个入口做两件事：建工作区（/api/workspaces）之后立刻同步（/api/workspace/sync）。
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

  const sync = async (workspaceName) => {
    setBusy(true)
    setError(null)
    try {
      const data = await postJSON('/workspace/sync', { workspace: workspaceName })
      setCreated({ workspace: { name: workspaceName }, run: data.run })
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
    // 连接信息：网关自报的控制面地址 / 证书来源 / token 位置，只读展示（真实取值来自 GET /api/health）。
    h(
      'div',
      { className: 'dcu-card' },
      h(
        'div',
        { className: 'dcu-card-head' },
        h(Dot, { tone: health ? 'ok' : 'bad' }),
        h('b', { className: 'dcu-node' }, '连接信息'),
        h('span', { className: 'dcu-spacer' }),
        h('span', { className: 'dcu-muted', style: { fontSize: 11 } }, health ? `网关更新 ${agoText(health.ts)}` : '读不到网关'),
      ),
      health
        ? h(
            'div',
            { className: 'dcu-kv', style: { flexDirection: 'column', gap: 3, alignItems: 'flex-start' } },
            h('span', null, '控制面 ', h('b', { className: 'dcu-mono' }, health.control || '—')),
            h('span', null, '证书 ', h('b', { className: 'dcu-mono' }, health.tls && health.tls.enabled ? `${health.tls.dir || '—'} · ${health.tls.cert_name || '—'}` : '未启用 mTLS')),
            h('span', null, 'token ', h('b', { className: 'dcu-mono' }, health.token_file || '—')),
            h('span', null, 'state ', h('b', { className: 'dcu-mono' }, health.state_dir || '—')),
          )
        : h(
            'div',
            { className: 'dcu-muted', style: { fontSize: 12 } },
            '网关没跑或 token 读不到。启动：python -m cluster ui --control https://127.0.0.1:18100 --port 18150 --tls-dir .state\\tls --cert-name win',
          ),
    ),
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
            `已创建 ${created.workspace.name}；首轮同步 ${created.run.id}（${created.run.status}）：${Object.entries(created.workspace.roots || {}).map(([node, root]) => `${node}→${root}`).join('，')}`)
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
              h('button', { className: 'dcu-btn', onClick: () => sync(item.name), disabled: busy }, '同步'),
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
;