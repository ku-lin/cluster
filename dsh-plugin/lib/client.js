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
/* Hallmark · macrostructure: operational workspace · tone: technical · anchor hue: blue
 * References: Tabler (card hierarchy + spacing) and Beszel (fleet status visibility).
 * Design decisions only; no source code copied. */
.dcu-root,.dcu-settings {
  --dcu-page:#f4f6fa; --dcu-surface:#fff; --dcu-ink:#182433; --dcu-muted:#66788a;
  --dcu-line:#d8e1eb; --dcu-line-soft:#e8edf3; --dcu-accent:#206bc4;
  --dcu-cpu:#2876d2; --dcu-mem:#8b6ccf;
  --dcu-good:#178a6b; --dcu-good-bg:#e6f5ef; --dcu-warn:#9a5c07; --dcu-warn-bg:#fdf0dc;
  --dcu-bad:#d63939; --dcu-bad-bg:#fdecec;
  --dcu-command:#12253a; --dcu-command-ink:#eaf2ff; --dcu-command-muted:#9db2c9;
  --dcu-health-bg:#eaf0f8; --dcu-health-bg-2:#dfe8f4;
  --dcu-r-lg:12px; --dcu-r-md:8px; --dcu-r-sm:6px;
  --dcu-elev:0 1px 2px #18243308;
  --dcu-display:'Segoe UI Variable Display','Segoe UI',system-ui,sans-serif;
  --dcu-body-font:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;
  --dcu-mono:ui-monospace,Consolas,'Courier New',monospace;
  font-family:var(--dcu-body-font); color:var(--dcu-ink);
}
body[data-ds-dark-theme] .dcu-root,body[data-ds-dark-theme] .dcu-settings {
  --dcu-page:#0f1822; --dcu-surface:#182433; --dcu-ink:#e7edf5; --dcu-muted:#a0afc0;
  --dcu-line:#324458; --dcu-line-soft:#28394c; --dcu-accent:#6aabfa;
  --dcu-cpu:#65a6f2; --dcu-mem:#b09ae7;
  --dcu-good:#5cd0aa; --dcu-good-bg:#173c36; --dcu-warn:#f5be6c; --dcu-warn-bg:#3f3320;
  --dcu-bad:#ff8d8d; --dcu-bad-bg:#452a33;
  --dcu-command:#152436; --dcu-command-ink:#eaf2ff; --dcu-command-muted:#93a8c0;
  --dcu-health-bg:#1c2e42; --dcu-health-bg-2:#22374e; --dcu-elev:none;
}
.dcu-settings { background:var(--dcu-page); padding:20px; border-radius:var(--dcu-r-lg); }
.dcu-root { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--dcu-page); }

/* 顶栏与标签：Tabler 式「表面 + 细分割线」，让内容区成为唯一的视觉舞台。 */
.dcu-head { order:1; flex:none; display:flex; align-items:center; gap:12px; padding:16px 28px; background:var(--dcu-surface); border-bottom:1px solid var(--dcu-line-soft); }
.dcu-title { display:flex; align-items:center; gap:10px; font:700 22px/1.2 var(--dcu-display); letter-spacing:-.6px; flex:none; }
.dcu-brandmark { display:grid; grid-template-columns:repeat(2,6px); gap:3px; padding:8px; border-radius:8px; background:var(--dcu-accent); }
.dcu-brandmark i { width:6px; height:6px; border-radius:1.5px; background:#fff; }
.dcu-sub { font-size:12px; color:var(--dcu-muted); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dcu-head .dcu-btn { flex:none; }
.dcu-spacer { flex:1 1 auto; }
.dcu-tabs { order:2; flex:none; display:flex; gap:22px; padding:0 28px; background:var(--dcu-surface); border-bottom:1px solid var(--dcu-line-soft); }
.dcu-tab { border:0; background:none; cursor:pointer; padding:12px 0; font-size:13px; font-weight:500; color:var(--dcu-muted); border-bottom:2px solid transparent; margin-bottom:-1px; }
.dcu-tab:hover { color:var(--dcu-ink); }
.dcu-tab[data-active=true] { color:var(--dcu-accent); border-bottom-color:var(--dcu-accent); font-weight:600; }

/* 内容区：唯一可滚动区域。底部留出 composer 高度由 flex 自动处理，不靠魔法 padding。 */
.dcu-body { order:3; flex:1 1 auto; min-height:0; overflow:auto; padding:24px 28px 32px; width:100%; max-width:1600px; margin:0 auto; box-sizing:border-box; }
/* Router 做成常驻底部指令条：DOM 在 body 之后、flex 最后一项，因此**不会盖住内容**。
   展开时最多占 46vh，日志区内部滚动——否则对话一长就把输入框和下面的页面一起挤出视口。 */
.dcu-router { order:9; flex:none; display:flex; flex-direction:column; max-height:42vh; margin:0; border-top:1px solid var(--dcu-line); border-radius:0; background:var(--dcu-command); color:var(--dcu-command-ink); box-shadow:none; }
.dcu-router-head { flex:none; flex-wrap:wrap; gap:9px; padding:9px 20px; border-bottom:0; }
.dcu-router.collapsed .dcu-router-head { border-bottom:0; }
.dcu-router-title { font-size:11px; letter-spacing:.1em; color:var(--dcu-command-ink); }
.dcu-router-tag { color:var(--dcu-command-muted); font-size:12px; flex:1 1 120px; }
.dcu-router-head .dcu-btn { background:transparent; color:var(--dcu-command-ink); border-color:#ffffff2e; }
.dcu-router-head .dcu-btn:hover { background:#ffffff14; border-color:#ffffff5c; }
.dcu-router-log { flex:1 1 auto; min-height:0; overflow:auto; padding:12px 20px; border-top:1px solid #ffffff1a; }
.dcu-turn-user { color:#9ec5ff; }
.dcu-turn-reply { color:var(--dcu-command-ink); }
.dcu-turn-meta,.dcu-hint { color:var(--dcu-command-muted); }
.dcu-router-input { flex:none; padding:10px 20px 12px; border-top:1px solid #ffffff1a; }
.dcu-router-input textarea { background:#ffffff0f; border-color:#ffffff2e; color:var(--dcu-command-ink); }
.dcu-router-input textarea::placeholder { color:var(--dcu-command-muted); }
.dcu-router-send { background:var(--dcu-accent); border-color:transparent; color:#fff; }
.dcu-action { border-color:#ffffff33; color:#c8dcf5; }

/* 通用表面 */
.dcu-chart,.dcu-card,.dcu-run { background:var(--dcu-surface); border:1px solid var(--dcu-line-soft); border-radius:var(--dcu-r-lg); box-shadow:var(--dcu-elev); min-width:0; }
/* overview 里的每一块都是"整块内容"，不该被压缩。
   否则底部 Router 展开、可用高度变小时，flex 会按 shrink 直接把节点卡挤扁
   （实测卡片从 ~190px 压到 ~80px，卡片内部文字互相重叠），而不是让 body 滚动。
   页面整体滚动交给 .dcu-body，块内不参与压缩。 */
.dcu-overview { display:flex; flex-direction:column; gap:18px; }
/* .dcu-body 是 flex 列容器：里面的整块内容一律不收缩，否则 Router 展开、可用高度
   变小时会把概览压扁（实测节点卡从 ~190px 压到 ~78px，文字重叠），而不是让 body 滚动。 */
.dcu-body > * { flex:none; }
.dcu-overview > * { flex:none; }
/* 卡片栅格的行高跟随内容，不随容器压缩。 */
.dcu-cards { grid-auto-rows:min-content; }
.dcu-cards > * { min-height:0; }

/* 1 · 实时健康带：本页的重心。左侧一句话结论，右侧每台节点的真实状态。 */
.dcu-health { display:grid; grid-template-columns:minmax(0,1fr) minmax(230px,.62fr); gap:26px; padding:22px 26px; border-radius:14px; background:var(--dcu-health-bg); border:1px solid var(--dcu-health-bg-2); position:relative; overflow:hidden; }
.dcu-health::before { content:''; position:absolute; inset:0 auto 0 0; width:4px; background:var(--dcu-good); }
.dcu-health[data-state=warn]::before { background:var(--dcu-warn); }
.dcu-health[data-state=bad]::before { background:var(--dcu-bad); }
.dcu-health[data-state=unknown]::before { background:var(--dcu-muted); }
.dcu-health-eyebrow { display:flex; align-items:center; gap:7px; font-size:11px; font-weight:650; letter-spacing:.09em; text-transform:uppercase; color:var(--dcu-muted); }
.dcu-health-signal { width:7px; height:7px; border-radius:50%; background:var(--dcu-good); }
.dcu-health[data-state=warn] .dcu-health-signal { background:var(--dcu-warn); }
.dcu-health[data-state=bad] .dcu-health-signal { background:var(--dcu-bad); }
.dcu-health h1 { margin:9px 0 7px; font:650 27px/1.25 var(--dcu-display); letter-spacing:-.7px; overflow-wrap:anywhere; }
.dcu-health p { margin:0; font-size:12.5px; line-height:1.7; color:var(--dcu-muted); }
.dcu-health-tags { display:flex; flex-wrap:wrap; gap:6px; margin-top:14px; }
.dcu-health-tags>span { font-size:11px; padding:3px 8px; border-radius:5px; background:var(--dcu-good-bg); color:var(--dcu-good); }
.dcu-health-tags>span.attention { background:var(--dcu-warn-bg); color:var(--dcu-warn); }
.dcu-health-nodes { display:flex; flex-direction:column; justify-content:center; gap:8px; min-width:0; }
.dcu-health-node { display:grid; grid-template-columns:7px minmax(0,1fr) auto auto; align-items:center; gap:9px; padding:9px 12px; border-radius:9px; background:var(--dcu-surface); border:1px solid var(--dcu-line-soft); font-size:11.5px; }
.dcu-health-node-mark { width:7px; height:7px; border-radius:50%; background:var(--dcu-good); }
.dcu-health-node strong { font:600 12px var(--dcu-mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dcu-ink); }
.dcu-health-node-state { color:var(--dcu-good); font-weight:600; }
.dcu-health-node-metric { font:11px var(--dcu-mono); color:var(--dcu-muted); }
.dcu-health-node[data-state=warn] .dcu-health-node-mark { background:var(--dcu-warn); }
.dcu-health-node[data-state=warn] .dcu-health-node-state { color:var(--dcu-warn); }
.dcu-health-node[data-state=stale] .dcu-health-node-mark { background:var(--dcu-warn); }
.dcu-health-node[data-state=stale] .dcu-health-node-state { color:var(--dcu-warn); }
.dcu-health-node[data-state=bad] .dcu-health-node-mark { background:var(--dcu-bad); }
.dcu-health-node[data-state=bad] .dcu-health-node-state { color:var(--dcu-bad); }

/* 2 · 指标条：数字仍是主角，但降一档，不与健康带争重心。 */
.dcu-strip { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; border:0; background:none; box-shadow:none; border-radius:0; overflow:visible; }
.dcu-stat { display:flex; flex-direction:column; gap:6px; padding:14px 16px; margin:0; background:var(--dcu-surface); border:1px solid var(--dcu-line-soft); border-radius:10px; box-shadow:var(--dcu-elev); min-width:0; }
.dcu-stat-top { display:flex; align-items:center; gap:6px; min-width:0; }
.dcu-stat-label { font-size:11px; font-weight:600; color:var(--dcu-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dcu-stat-value { display:flex; align-items:baseline; gap:5px; font:650 26px/1.1 var(--dcu-display); letter-spacing:-.5px; font-variant-numeric:tabular-nums; color:var(--dcu-ink); white-space:nowrap; overflow:hidden; }
.dcu-stat-unit { font-size:12px; font-weight:500; color:var(--dcu-muted); letter-spacing:0; }
.dcu-stat-note { font-size:11px; color:var(--dcu-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dcu-stat .dcu-dot { width:6px; height:6px; }

/* 3 · 工作台：左「节点运行状况」是主列，右「任务 / 同步」是窄栏。 */
.dcu-workbench { display:grid; grid-template-columns:minmax(0,1fr) 316px; gap:18px; align-items:start; }
.dcu-fleet,.dcu-operations { display:flex; flex-direction:column; gap:14px; min-width:0; }
.dcu-rule { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; padding:0 2px; }
.dcu-rule::after { display:none; }
.dcu-rule-title { font-size:15px; font-weight:650; letter-spacing:-.2px; }
.dcu-rule-note { margin-left:auto; font-size:11px; color:var(--dcu-muted); white-space:nowrap; }
.dcu-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr)); gap:14px; align-items:start; }
.dcu-empty { padding:24px; text-align:center; font-size:12px; color:var(--dcu-muted); border:1px dashed var(--dcu-line); border-radius:10px; }

/* 节点卡：顶部 3px 状态色条 + 状态胶囊，扫一眼就知道这台能不能干活。 */
.dcu-host-card { position:relative; display:flex; flex-direction:column; gap:13px; min-height:188px; padding:16px 18px 14px; border-top:3px solid var(--dcu-good); }
.dcu-host-card[data-state=warn],.dcu-host-card[data-state=stale] { border-top-color:var(--dcu-warn); }
.dcu-host-card[data-state=bad] { border-top-color:var(--dcu-bad); }
.dcu-host-status { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:11px; color:var(--dcu-muted); }
.dcu-status-pill { display:inline-flex; align-items:center; gap:5px; padding:3px 8px; border-radius:5px; font-size:11px; font-weight:650; background:var(--dcu-good-bg); color:var(--dcu-good); white-space:nowrap; }
.dcu-status-pill[data-state=warn],.dcu-status-pill[data-state=stale] { background:var(--dcu-warn-bg); color:var(--dcu-warn); }
.dcu-status-pill[data-state=bad] { background:var(--dcu-bad-bg); color:var(--dcu-bad); }
.dcu-host-symbol { display:none; }
.dcu-card-head { display:flex; align-items:center; gap:7px; flex-wrap:wrap; min-width:0; }
.dcu-card-head>.dcu-dot { display:none; }
.dcu-node { font:650 17px/1.2 var(--dcu-display); letter-spacing:-.3px; color:var(--dcu-ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dcu-card-head>.dcu-cap { margin-left:auto; font-size:10.5px; }
.dcu-chip { padding:1px 7px; border-radius:4px; font-size:10px; background:var(--dcu-page); border:1px solid var(--dcu-line-soft); color:var(--dcu-muted); white-space:nowrap; }
.dcu-metrics { display:grid; grid-template-columns:1fr 1fr; gap:8px 18px; }
.dcu-meter { display:flex; flex-direction:column; gap:5px; min-width:0; }
.dcu-meter-head { display:flex; justify-content:space-between; align-items:baseline; gap:6px; font-size:11px; color:var(--dcu-muted); }
.dcu-meter-head>span:last-child { font:600 13px var(--dcu-mono); color:var(--dcu-ink); }
.dcu-meter-track { height:5px; border-radius:999px; background:var(--dcu-line-soft); overflow:hidden; }
.dcu-meter-fill { height:100%; border-radius:999px; background:var(--dcu-cpu); transition:width .3s ease; }
.dcu-meter-fill.warn { background:var(--dcu-warn); }
.dcu-meter-fill.bad { background:var(--dcu-bad); }
.dcu-kv { display:flex; flex-wrap:wrap; gap:5px 14px; font-size:11px; color:var(--dcu-muted); }
.dcu-kv b { color:var(--dcu-ink); font-weight:650; font-variant-numeric:tabular-nums; }
.dcu-host-trend { padding:7px 9px 3px; border-radius:7px; background:var(--dcu-page); }
.dcu-trend-caption { display:flex; justify-content:space-between; gap:8px; font-size:10px; color:var(--dcu-muted); margin-bottom:5px; }
.dcu-host-trend .dcu-spark { height:38px; }
.dcu-spark { width:100%; display:block; }
.dcu-spark-empty { height:38px; display:flex; align-items:center; font-size:11px; color:var(--dcu-muted); }
.dcu-fold { border-top:1px solid var(--dcu-line-soft); padding-top:8px; }
.dcu-fold>summary { display:flex; align-items:center; gap:6px; cursor:pointer; list-style:none; font-size:11px; color:var(--dcu-muted); padding:2px 0; }
.dcu-fold>summary::-webkit-details-marker { display:none; }
.dcu-fold>summary::before { content:'▸'; font-size:9px; transition:transform .12s ease; }
.dcu-fold[open]>summary::before { transform:rotate(90deg); }
.dcu-fold>summary:hover { color:var(--dcu-ink); }
.dcu-agents { display:flex; flex-direction:column; gap:5px; padding-top:8px; }
.dcu-agent { display:grid; grid-template-columns:10px minmax(0,1fr) auto auto; gap:9px; align-items:center; font-size:11.5px; }
.dcu-agent-id { font:11px var(--dcu-mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dcu-muted { color:var(--dcu-muted); }
.dcu-cap { font-size:11px; }
.dcu-cap-lg { font-size:12px; }
.dcu-name { font-size:13px; font-weight:650; }
.dcu-conflict { font-size:11px; }

/* 右栏卡片：任务队列 + 同步状态 */
.dcu-chart,.dcu-run { padding:16px 18px; display:flex; flex-direction:column; gap:13px; }
.dcu-chart-head { display:flex; align-items:center; gap:8px; }
.dcu-chart-title,.dcu-section-title { font-size:13.5px; font-weight:650; letter-spacing:-.1px; }
.dcu-section-title { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; }
.dcu-section-title>.dcu-cap-lg { font-size:10px; font-weight:400; }
.dcu-chart-foot { font-size:10px; color:var(--dcu-muted); }
.dcu-qbar { display:flex; height:8px; border-radius:999px; overflow:hidden; background:var(--dcu-line-soft); }
.dcu-qseg { height:100%; }
.dcu-qseg.waiting { background:var(--dcu-warn); opacity:.55; }
.dcu-qseg.running { background:var(--dcu-accent); }
.dcu-qseg.done { background:var(--dcu-good); opacity:.85; }
.dcu-qseg.failed { background:var(--dcu-bad); }
.dcu-qseg.cancelled,.dcu-qseg.unknown { background:var(--dcu-muted); opacity:.4; }
.dcu-qkeys { display:grid; grid-template-columns:1fr 1fr; gap:8px 14px; font-size:11px; color:var(--dcu-muted); }
.dcu-qkey { display:grid; grid-template-columns:7px minmax(0,1fr) auto; align-items:center; gap:6px; }
.dcu-qkey b { font:650 15px var(--dcu-mono); color:var(--dcu-ink); }
.dcu-qkey>.dcu-dot { width:7px; height:7px; border-radius:2px; }
.dcu-operations .dcu-sync-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px 8px; align-items:center; padding:10px 0 10px 14px; border-bottom:1px solid var(--dcu-line-soft); position:relative; }
.dcu-operations .dcu-sync-row::before { position:absolute; left:0; top:14px; }
.dcu-operations .dcu-fold[open]>.dcu-sync-row::before { transform:rotate(90deg); }
.dcu-operations .dcu-sync-name { font-size:12.5px; font-weight:650; grid-column:1; }
.dcu-operations .dcu-sync-row>span:nth-child(2) { grid-column:2; grid-row:1; justify-self:end; }
.dcu-operations .dcu-sync-time { grid-column:2; grid-row:2; justify-self:end; font-size:10.5px; color:var(--dcu-muted); }
.dcu-operations .dcu-sync-note { grid-column:1; grid-row:2; font-size:10.5px; white-space:normal; }
.dcu-badge { display:inline-block; padding:2px 7px; border-radius:4px; font-size:10px; font-weight:600; border:0; white-space:nowrap; }
.dcu-badge.done { color:var(--dcu-good); background:var(--dcu-good-bg); }
.dcu-badge.partial,.dcu-badge.conflict { color:var(--dcu-warn); background:var(--dcu-warn-bg); }
.dcu-badge.failed { color:var(--dcu-bad); background:var(--dcu-bad-bg); }
.dcu-badge.running { color:var(--dcu-accent); background:#e7f0fb; }
/* 高负载数值标红，但条形保持固定色相：颜色只用来提示"这个数要看了"。 */
.dcu-hot { color:var(--dcu-bad); font-weight:600; }

/* 图表（同步页/设置页仍在用） */
.dcu-charts { display:grid; grid-template-columns:minmax(0,1.3fr) minmax(0,1fr); gap:18px; }
.dcu-bars { display:flex; flex-direction:column; gap:12px; }
.dcu-bar-node { display:grid; grid-template-columns:86px minmax(0,1fr) 120px; gap:12px; align-items:center; }
.dcu-bar-name { font-size:12px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dcu-bar-pair { display:flex; flex-direction:column; gap:5px; min-width:0; }
.dcu-bar { display:grid; grid-template-columns:30px minmax(0,1fr); gap:8px; align-items:center; }
.dcu-bar-tag { font-size:10px; font-weight:600; color:var(--dcu-muted); }
.dcu-bar-track { height:7px; border-radius:999px; background:var(--dcu-line-soft); overflow:hidden; }
.dcu-bar-fill { display:block; height:100%; border-radius:999px; background:var(--dcu-cpu); transition:width .3s ease; }
.dcu-bar-fill.mem { background:var(--dcu-mem); }
.dcu-bar-fill.bad { background:var(--dcu-bad); }
.dcu-bar-vals { font:11px var(--dcu-mono); color:var(--dcu-muted); text-align:right; white-space:nowrap; }
.dcu-legend { display:flex; gap:12px; font-size:11px; color:var(--dcu-muted); align-items:center; }
.dcu-legend-swatch { width:10px; height:3px; border-radius:2px; display:inline-block; margin-right:4px; vertical-align:middle; }

/* 表单 / 按钮 / 设置页 */
.dcu-btn { border:1px solid var(--dcu-line); background:var(--dcu-surface); color:var(--dcu-ink); border-radius:var(--dcu-r-sm); padding:6px 12px; font:500 12px var(--dcu-body-font); cursor:pointer; white-space:nowrap; transition:background .15s ease,border-color .15s ease; }
.dcu-btn:hover { background:var(--dcu-page); border-color:var(--dcu-line); }
.dcu-btn:focus-visible { outline:2px solid var(--dcu-accent); outline-offset:2px; }
.dcu-btn:disabled { opacity:.45; cursor:default; }
.dcu-btn.primary { background:var(--dcu-accent); border-color:transparent; color:#fff; font-weight:600; }
.dcu-btn.warn { border-color:#d99a49; color:#94580f; }
body[data-ds-dark-theme] .dcu-btn.warn { color:#f0c07a; }
.dcu-input,.dcu-select { border:1px solid var(--dcu-line); border-radius:var(--dcu-r-sm); padding:7px 10px; font:12px var(--dcu-body-font); background:var(--dcu-surface); color:var(--dcu-ink); }
.dcu-input:focus,.dcu-select:focus { outline:none; border-color:var(--dcu-accent); box-shadow:0 0 0 3px #206bc41f; }
.dcu-form { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.dcu-error { border:1px solid var(--dcu-bad); color:var(--dcu-bad); border-radius:var(--dcu-r-md); padding:9px 12px; font-size:12px; }
.dcu-overview>.dcu-error,.dcu-run>.dcu-error,.dcu-settings>.dcu-error { background:var(--dcu-surface); }
.dcu-router .dcu-error { background:#d6393924; border-color:#ff8d8d; color:#ffc9c9; margin:0 20px 8px; }
.dcu-table { width:100%; border-collapse:collapse; font-size:11.5px; }
.dcu-table th { text-align:left; padding:7px 9px; font-size:10px; letter-spacing:.04em; text-transform:uppercase; color:var(--dcu-muted); border-bottom:1px solid var(--dcu-line); font-weight:600; }
.dcu-table td { padding:7px 9px; border-bottom:1px solid var(--dcu-line-soft); vertical-align:top; }
.dcu-table tr:last-child td { border-bottom:0; }
.dcu-mono { font-family:var(--dcu-mono); }
.dcu-roots { display:flex; flex-direction:column; gap:3px; font:10.5px var(--dcu-mono); color:var(--dcu-muted); }
.dcu-settings { display:flex; flex-direction:column; gap:16px; }
.dcu-summary { display:flex; flex-wrap:wrap; gap:6px; }

@media (max-width:1240px) {
  .dcu-workbench { grid-template-columns:minmax(0,1fr) 290px; }
  .dcu-health { grid-template-columns:minmax(0,1fr) 220px; gap:20px; }
  .dcu-stat-value { font-size:23px; }
  .dcu-stat-note { white-space:normal; }
}
@media (max-width:1000px) {
  .dcu-workbench { grid-template-columns:1fr; }
  .dcu-operations { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); align-items:start; }
  .dcu-cards { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .dcu-strip { grid-template-columns:repeat(3,minmax(0,1fr)); }
  .dcu-bar-vals { text-align:left; }
}
@media (max-width:700px) {
  .dcu-head { padding:14px 16px; }
  .dcu-title { font-size:20px; }
  .dcu-sub { display:none; }
  .dcu-tabs { padding:0 16px; gap:18px; }
  .dcu-body { padding:16px; }
  .dcu-health { grid-template-columns:1fr; padding:18px 20px; gap:16px; }
  .dcu-health h1 { font-size:23px; }
  .dcu-strip { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .dcu-cards,.dcu-operations { grid-template-columns:1fr; }
  .dcu-rule-note { margin-left:0; }
  .dcu-bar-node { grid-template-columns:1fr; gap:6px; }
  .dcu-bar-vals { text-align:left; }
  .dcu-router-head { padding:9px 16px; }
  .dcu-router-log,.dcu-router-input { padding-left:16px; padding-right:16px; }
  .dcu-settings { padding:14px; }
}
@media (prefers-reduced-motion:reduce) {
  .dcu-root *,.dcu-settings *,.dcu-root *::before { transition:none!important; animation:none!important; }
}

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
    memArea ? h('path', { d: memArea, fill: 'var(--dcu-mem)', opacity: 0.16, stroke: 'none' }) : null,
    cpuArea ? h('path', { d: cpuArea, fill: 'var(--dcu-cpu)', opacity: 0.16, stroke: 'none' }) : null,
    memPath ? h('path', { d: memPath, fill: 'none', stroke: 'var(--dcu-mem)', strokeWidth: 1.3, vectorEffect: 'non-scaling-stroke', opacity: 0.95 }) : null,
    cpuPath ? h('path', { d: cpuPath, fill: 'none', stroke: 'var(--dcu-cpu)', strokeWidth: 1.6, vectorEffect: 'non-scaling-stroke' }) : null,
    h('g', { style: { color: 'var(--dcu-cpu)' } }, dotAt(lastCpu)),
  )
}

/* ------------------------------------------------------------------ 首屏：健康总览 */
/**
 * 一格统计：上行「状态点 + 小标签」，下行大数字，第三行一句注解。
 *
 * 为什么把标签和大数字分成两行：原先一行平铺（`节点 2/2 全部在线`）时，标签和数字
 * 字号只差 2px，扫视时整条读成一串字，五格之间没有重心。分行之后 30px 的数字自己
 * 立成视觉锚点，一格里"最要紧的那个数"先被看见，注解退到次要色。
 */
function Stat({ tone, label, value, unit, note, title }) {
  return h(
    'div',
    { className: 'dcu-stat', title },
    h('span', { className: 'dcu-stat-top' }, tone ? h(Dot, { tone }) : null, h('span', { className: 'dcu-stat-label' }, label)),
    h('span', { className: 'dcu-stat-value' }, value, unit ? h('span', { className: 'dcu-stat-unit' }, unit) : null),
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
  const total = num(queue.total) ?? 0
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
      label: 'Quorum',
      // 大数字直接给「quorum / 副本数」这一对比值：只写 2 的话看不出它是几选几。
      value: quorum === null ? '—' : `${quorum}/${peers.length + 1}`,
      note: peers.length ? `${peers.length + 1} 副本` : '单副本',
      title: '控制面 quorum 与对等副本数',
    }),
    h(Stat, {
      tone: taskTone,
      label: '运行中任务',
      // 大数字放"正在跑的条数"，其余分桶退到注解行：一格里只能有一个重心。
      value: `${running}`,
      note: `排队 ${waiting} · 历史失败 ${failed} · 共 ${total} 条`,
      title: '任务队列分桶（pending/queued 归入排队，claimed/running 归入运行）',
    }),
    h(Stat, {
      tone: syncTone,
      label: '最近完成的同步',
      value: syncText(syncStatus),
      note: workspaces.length ? `${workspaces.length} 个工作区` : '还没有工作区',
      title: '最近完成的那一轮同步的 status（done/partial/failed）；逐工作区的结果与冲突数见下方「同步状态」',
    }),
    h(Stat, { tone: rttTone, label: '控制面', value: rtt === null ? '—' : `${Math.round(rtt)}`, unit: 'ms', note: '网关快照往返', title: '网关到控制面的一次快照耗时' }),
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
    return h('section', { className: 'dcu-chart', 'aria-label': '节点资源' }, h('div', { className: 'dcu-chart-head' }, h('span', { className: 'dcu-chart-title' }, '节点资源')), h('div', { className: 'dcu-muted dcu-cap-lg' }, '还没有节点数据。'))
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
        h('span', null, h('span', { className: 'dcu-legend-swatch', style: { background: 'var(--dcu-cpu)' } }), ' CPU'),
        h('span', null, h('span', { className: 'dcu-legend-swatch', style: { background: 'var(--dcu-mem)' } }), ' 内存'),
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
          // 不把整条填色改成红色：那会打破"CPU 永远蓝、内存永远紫"的固定色相，
          // 同一张图里冒出第三种颜色，就读不出它属于哪根指标了。高负载由数值变红提示。
          h('div', { className: 'dcu-bar-track' }, h('span', { className: `dcu-bar-fill ${cls}`, style: { width: `${value === null ? 0 : Math.max(0, Math.min(100, value))}%` } }))
        const hot = (value) => value !== null && value >= 90
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
            h('span', { className: hot(cpu) ? 'dcu-hot' : null }, percent(cpu)),
            ' · ',
            h('span', { className: hot(mem) ? 'dcu-hot' : null }, percent(mem)),
            num(metrics.cpu_count) ? h('span', { className: 'dcu-muted' }, ` / ${metrics.cpu_count} 核`) : null,
          ),
        )
      }),
    ),
    h('div', { className: 'dcu-chart-foot' }, '刻度 0–100%；数值标红表示该项已达 90% 以上'),
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
    ['failed', '历史失败'],
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
    h('div', { className: 'dcu-chart-head' }, h('span', { className: 'dcu-chart-title' }, '任务队列'), h('span', { className: 'dcu-spacer' }), h('span', { className: 'dcu-muted dcu-cap' }, `共 ${total}`)),
    total === 0
      ? h('div', { className: 'dcu-muted dcu-cap-lg' }, '还没有任务：在 Router 里下一条指令就会出现在这里。')
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
            loading && !recent ? h('div', { className: 'dcu-muted dcu-cap' }, '读取中…') : null,
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
  // 与顶部健康带共用同一套判定：否则会出现「标题说高负载、这张卡说在线」。
  const cond = nodeCondition(host)
  const level = NODE_LEVEL[cond]
  const cpuValue = num(metrics.cpu_percent)
  const memValue = num(metrics.mem_percent)
  // 异常必须带原因。只给一个红点，用户还得自己去猜是 CPU 高还是采样断了。
  const reason =
    cond === 'offline'
      ? `最后一次上报 ${agoText(metrics.ts)}`
      : cond === 'stale'
        ? `采样停在 ${agoText(metrics.ts)}`
        : cond === 'hot'
          ? [
              cpuValue !== null && cpuValue >= 90 ? `CPU ${Math.round(cpuValue)}%` : null,
              memValue !== null && memValue >= 90 ? `内存 ${Math.round(memValue)}%` : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : cond === 'degraded'
            ? `${(host.plugins_down || []).length} 个能力不可用`
            : null
  return h(
    'article',
    { className: 'dcu-card dcu-host-card', 'data-state': level },
    h(
      'div',
      { className: 'dcu-host-status' },
      h('span', { className: 'dcu-status-pill', 'data-state': level }, h(Dot, { tone: NODE_TONE[cond] }), NODE_TEXT[cond]),
      reason
        ? h('span', { className: 'dcu-host-reason' }, reason)
        : h('span', { className: 'dcu-muted dcu-cap' }, host.role === 'router' ? '路由节点' : '执行节点'),
    ),
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
      h('span', { className: 'dcu-muted dcu-cap' }, `更新 ${agoText(metrics.ts)}`),
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
        kindText ? h('div', { className: 'dcu-muted dcu-cap' }, kindText) : null,
        h(
          'div',
          { className: 'dcu-host-trend' },
          h(
            'div',
            { className: 'dcu-trend-caption' },
            h('span', null, 'CPU / 内存趋势'),
            h('span', null, host.alive ? '最近采样' : '最后已知采样'),
          ),
          h(Spark, { points: host.history || [], height: 48 }),
        ),
        h(
          'div',
          { className: 'dcu-agents' },
          agents.length === 0
            ? h('div', { className: 'dcu-muted dcu-cap-lg' }, '该节点没有注册能力')
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
    return h('div', { className: 'dcu-run' }, h('div', { className: 'dcu-section-title' }, '同步'), h('div', { className: 'dcu-muted dcu-cap-lg' }, '还没有工作区：在「同步」页或设置页新建一个。'))
  }
  return h(
    'div',
    { className: 'dcu-run' },
    h('div', { className: 'dcu-section-title' }, '同步状态', h('span', { className: 'dcu-muted dcu-cap-lg' }, '（每个工作区最近一轮）')),
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
          h('span', null, status ? h('span', { className: `dcu-badge ${status}` }, syncText(status)) : h('span', { className: 'dcu-muted dcu-cap' }, '未同步')),
          h(
            'span',
            { className: 'dcu-sync-note' },
            conflicts > 0
              ? h('span', { className: 'dcu-badge conflict' }, `冲突 ${conflicts}`)
              : h('span', { className: 'dcu-muted' }, '无冲突'),
            note ? `  ${note}` : '',
          ),
          h('span', { className: 'dcu-sync-time' }, last.finished ? agoText(last.finished) : '—'),
        ),
        h(
          'div',
          { style: { paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', { className: 'dcu-muted dcu-cap' }, `${last.id || '—'} · 策略 ${last.policy || item.policy || '—'} · 第 ${last.attempt || 1} 次 · 状态 ${syncText(status)}`),
          (last.nodes || []).length === 0
            ? h('div', { className: 'dcu-muted dcu-cap' }, '没有节点级记录')
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
// 首屏两段：实时健康带（本页重心）+ 工作台（左节点 / 右任务与同步）。
// 状态判定集中在一处，避免"标题说高负载、卡片说在线"这种自相矛盾。
// 首屏两段：实时健康带（本页重心）+ 工作台（左节点 / 右任务与同步）。
// 状态判定集中在一处，避免"标题说高负载、卡片说在线"这种自相矛盾。
// 首屏两段：实时健康带（本页重心）+ 工作台（左节点 / 右任务与同步）。
// 状态判定集中在一处，避免"标题说高负载、卡片说在线"这种自相矛盾。
// 首屏两段：实时健康带（本页重心）+ 工作台（左节点 / 右任务与同步）。
// 状态判定集中在一处，避免"标题说高负载、卡片说在线"这种自相矛盾。
function nodeCondition(host) {
  if (!host.alive) return 'offline'
  if (toneOfNode(host) === 'warn') return 'stale'
  const cpu = num(host.metrics && host.metrics.cpu_percent)
  const mem = num(host.metrics && host.metrics.mem_percent)
  if ((cpu !== null && cpu >= 90) || (mem !== null && mem >= 90)) return 'hot'
  if ((host.plugins_down || []).length) return 'degraded'
  return 'ok'
}

/** 节点状态 → 文案。同一台机器在健康带和卡片里必须说同一句话。 */
const NODE_TEXT = { ok: '在线', hot: '高负载', stale: '采样过期', degraded: '能力异常', offline: '离线' }
const NODE_TONE = { ok: 'ok', hot: 'warn', stale: 'warn', degraded: 'warn', offline: 'bad' }
/** 卡片顶条/胶囊用的 data-state（ok / warn / bad），把四种异常压到三档颜色。 */
const NODE_LEVEL = { ok: 'ok', hot: 'warn', stale: 'warn', degraded: 'warn', offline: 'bad' }

function ClusterHealth({ data, hosts, onRefresh }) {
  const queue = (data && data.queue) || { counts: {} }
  const running = (queue.counts && queue.counts.running) || 0
  const conds = hosts.map((host) => nodeCondition(host))
  const offline = conds.filter((c) => c === 'offline').length
  const hot = conds.filter((c) => c === 'hot').length
  const stale = conds.filter((c) => c === 'stale').length
  const degraded = conds.filter((c) => c === 'degraded').length
  const state = !hosts.length ? 'unknown' : offline ? 'bad' : hot || stale || degraded ? 'warn' : 'ok'
  const headline = !hosts.length
    ? '正在等待节点接入'
    : offline
      ? `${offline} 台节点离线`
      : hot
        ? `集群在线 · ${hot} 台节点高负载`
        : stale
          ? '集群在线 · 采样已过期'
          : degraded
            ? '集群在线 · 部分能力不可用'
            : '集群运行正常'
  const leadsUp = hosts.filter((host) => nodeCondition(host) !== 'offline').length
  const summary = hosts.length
    ? `${leadsUp} / ${hosts.length} 台节点在线 · ${running} 个任务运行中 · 每 5 秒自动刷新`
    : '注册节点后，这里会显示实时负载与能力状态。'
  return h(
    'section',
    { className: 'dcu-health', 'data-state': state, 'aria-label': '集群实时状态' },
    h(
      'div',
      { className: 'dcu-health-copy' },
      h('div', { className: 'dcu-health-eyebrow' }, h('span', { className: 'dcu-health-signal' }), '集群实时状态'),
      h('h1', null, headline),
      h('p', null, summary),
      h(
        'div',
        { className: 'dcu-health-tags' },
        h('span', null, offline ? `离线 ${offline}` : hosts.length ? '节点连接正常' : '暂无连接'),
        hot ? h('span', { className: 'attention' }, `高负载 ${hot}`) : null,
        stale ? h('span', { className: 'attention' }, `采样过期 ${stale}`) : null,
        degraded ? h('span', { className: 'attention' }, `能力异常 ${degraded}`) : null,
      ),
    ),
    hosts.length
      ? h(
          'div',
          { className: 'dcu-health-nodes', 'aria-label': '逐节点状态' },
          hosts.map((host) => {
            const cond = nodeCondition(host)
            const cpu = num(host.metrics && host.metrics.cpu_percent)
            return h(
              'div',
              { key: host.node_id, className: 'dcu-health-node', 'data-state': NODE_LEVEL[cond] },
              h('span', { className: 'dcu-health-node-mark' }),
              h('strong', { title: host.node_id }, host.node_id),
              h('span', { className: 'dcu-health-node-state' }, NODE_TEXT[cond]),
              h('span', { className: 'dcu-health-node-metric' }, cpu === null ? '—' : `CPU ${Math.round(cpu)}%`),
            )
          }),
        )
      : null,
  )
}

function Overview({ data, error, history }) {
  if (error && !data) return h('div', { className: 'dcu-error' }, error)
  if (!data) return h('div', { className: 'dcu-muted' }, '读取中…')
  const hosts = (data.items || []).map((host) => ({ ...host, history: mergeHistory(host.history, history[host.node_id]) }))
  return h(
    'div',
    { className: 'dcu-overview' },
    h(ClusterHealth, { data, hosts }),
    error ? h('div', { className: 'dcu-error', role: 'alert' }, error) : null,
    h(HealthStrip, { data }),
    h(
      'div',
      { className: 'dcu-workbench' },
      h(
        'div',
        { className: 'dcu-fleet' },
        h(
          'div',
          { className: 'dcu-rule' },
          h('span', { className: 'dcu-rule-title' }, '节点运行状况'),
          h('span', { className: 'dcu-rule-note' }, `${hosts.length} 台 · 明细默认折叠`),
        ),
        hosts.length
          ? h('div', { className: 'dcu-cards' }, hosts.map((host) => h(HostCard, { key: host.node_id, host })))
          : h('div', { className: 'dcu-empty' }, '还没有节点注册到控制面。'),
        h(ResourceBars, { hosts }),
      ),
      h(
        'aside',
        { className: 'dcu-operations', 'aria-label': '任务与同步' },
        h(QueueCard, { queue: data.queue }),
        h(SyncSummary, { workspaces: data.workspaces }),
      ),
    ),
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
      style: { background: 'var(--dcu-command)' },
    },
    h(
      'header',
      { className: 'dcu-router-head' },
      h(Dot, { tone: busy ? 'warn' : 'ok' }),
      h('span', { className: 'dcu-router-title' }, 'Router · 常驻'),
      h('span', { className: 'dcu-router-tag' }, collapsed ? lastLine : '真实 LLM 会话 · 只会调 cluster_* 工具（没有 shell）'),
      h('span', { className: 'dcu-spacer' }),
      h('button', { className: 'dcu-btn', style: { background: 'transparent', color: 'var(--dcu-command-ink)', borderColor: 'var(--dcu-command-muted)' }, onClick: () => setCollapsed(!collapsed) }, collapsed ? '展开对话' : '收起'),
      collapsed ? null : h('button', { className: 'dcu-btn', style: { background: 'transparent', color: 'var(--dcu-command-ink)', borderColor: 'var(--dcu-command-muted)' }, onClick: load, disabled: busy }, '刷新记录'),
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
      h('div', { className: 'dcu-section-title' }, 'cluster 工作区', h('span', { className: 'dcu-muted dcu-cap-lg' }, '（创建后立即同步所有节点）')),
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
        ? h('div', { className: 'dcu-muted dcu-cap-lg' }, `还没有工作区。节点根目录：${nodes.map((node) => `${node.node_id}=${node.os === 'windows' ? '<cluster 仓库>/.state/workspaces/<name>' : '~/cluster-test/workspaces/<name>'}`).join('，')}`)
        : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            workspaces.map((item) =>
              h(
                'div',
                { key: item.name, style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('b', { className: 'dcu-name' }, item.name),
                runBadge(item.last_status),
                h('span', { className: 'dcu-muted dcu-cap' }, `策略 ${item.policy}`),
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
            h('span', { className: 'dcu-muted dcu-cap' }, `${selected.id} · 第 ${selected.attempt} 次 · 策略 ${selected.policy} · 耗时 ${durationText((selected.finished || selected.updated || 0) - (selected.created || 0))}`),
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
                    { key: conflict.path, className: 'dcu-mono dcu-conflict', style: { paddingTop: 6 } },
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
      h('span', { className: 'dcu-title' }, h('span', { className: 'dcu-brandmark', 'aria-hidden': true }, h('i'), h('i'), h('i'), h('i')), 'Cluster'),
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
      h('span', { className: 'dcu-muted dcu-cap-lg' }, '一个工作区 = 每个节点上一个目录，内容保持一致')),
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
        h('span', { className: 'dcu-muted dcu-cap' }, health ? `网关更新 ${agoText(health.ts)}` : '读不到网关'),
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
            { className: 'dcu-muted dcu-cap-lg' },
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
        ? h('div', { className: 'dcu-muted dcu-cap-lg' },
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
              h('span', { className: 'dcu-muted dcu-cap' }, `策略 ${item.policy}`),
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