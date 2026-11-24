/**
 * 独立的 UI 预览/截图环境（不碰 3080，也不碰真实 cluster 网关）。
 *
 * 它做的事很少，但每件都必须真：
 *   1. 直接加载**仓库里那份** `dsh-plugin/lib/client.js`——不是重写的样板。
 *      `?which=baseline` 读 `git show HEAD:...` 那一版，`?which=after` 读工作区那份，
 *      这样"改前/改后"是同一份代码的两代，而不是两个手搓的 mock。
 *   2. 用真实 React 18 UMD + 一个最小 `window.__ModuleLoader__` 壳，复刻宿主
 *      给插件的 `require('react')` 与 `ctx.slots` / `ctx.layout` 契约。
 *   3. 样式表用 `build-tokens.mjs` 从本机 DSH 主题包里抽出的真 token，
 *      浅色/暗色与线上同一份色值。
 *   4. `/cluster-ui/api/*` 由 `fixtures.mjs` 回答，形状与 cluster 网关一致。
 *
 * 端口默认 3899，可用 `PORT` 覆盖。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildFixtures } from './fixtures.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const vendor = join(repo, '.cache', 'ui-harness', 'package', 'umd')
const PORT = Number(process.env.PORT || 3899)

/**
 * 冻结点。截图脚本用 `?now=` 传同一个时刻进来（毫秒，与 `Date.now()` 同单位），
 * 接口数据里的相对时间（「6m 前」「更新 3s 前」）才算同源——否则两次截图的文案会自己漂。
 * 网关那边的 ts 全是**秒**，所以这里除一次。
 */
const DEFAULT_NOW_MS = 1795000000000
const secondsOf = (nowMs) => Math.round((Number.isFinite(nowMs) ? nowMs : DEFAULT_NOW_MS) / 1000)
/** api() 收到的是**秒**（网关口径），这里不要再除一次。 */
const fixturesFor = (nowSec) => buildFixtures(Number.isFinite(nowSec) ? nowSec : secondsOf(DEFAULT_NOW_MS))

/**
 * baseline 用哪个提交，**必须显式钉住**，不能用 HEAD。
 *
 * 踩过的坑：最初写成 `git show HEAD:...`，服务启动那一刻 HEAD 已经是本次改动的提交了，
 * 于是「改前」其实取到了「改后」——对比图照样生成、副标题照样印版本号，但两侧是同一份
 * 代码。这类错误在图上完全看不出来，只能靠把提交号写死在代码里防住。
 *
 * 要换基线就改这里，并同步更新 compose.mjs 副标题读的那份清单。
 */
const BASELINE_REV = process.env.PREVIEW_BASELINE_REV || 'fc5ac39'

/** 把 BASELINE_REV 里那一版 client.js 落到 .cache，供 baseline 直接取用。 */
function materializeBaseline() {
  const cache = join(repo, '.cache', 'ui-harness', 'baseline')
  mkdirSync(cache, { recursive: true })
  const out = join(cache, 'client.js')
  const text = execFileSync('git', ['show', `${BASELINE_REV}:dsh-plugin/lib/client.js`], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  writeFileSync(out, text, 'utf8')
  return { path: out, rev: BASELINE_REV, sha: createHash('sha256').update(text).digest('hex') }
}

const baseline = materializeBaseline()

const PAGE = (which, theme, panel) => `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8" />
<title>cluster-ui preview · ${which} · ${theme}</title>
<link rel="stylesheet" href="/tokens.css" />
<style>
  /* 宿主给的画布：主面板在 DSH 里是 flex 撑满的内容区，这里给等价的两条约束。 */
  #host { height: 100%; display: flex; flex-direction: column; min-height: 0; }
  #host > * { min-height: 0; }
</style>
</head>
<body${theme === 'dark' ? ' data-ds-dark-theme=""' : ''}>
<div id="host"></div>
<script src="/vendor/react.js"></script>
<script src="/vendor/react-dom.js"></script>
<script>
  /* 运行时错误留档：截图脚本会读 window.__PREVIEW_ERRORS__，空白页也算失败。 */
  window.__PREVIEW_ERRORS__ = [];
  window.addEventListener('error', (event) => {
    window.__PREVIEW_ERRORS__.push(String((event.error && event.error.stack) || event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    window.__PREVIEW_ERRORS__.push('unhandledrejection: ' + String((event.reason && event.reason.stack) || event.reason));
  });
  /* React 18 的 createRoot 把渲染异常交给 onUncaughtError，默认只 console.error。 */
  const realError = console.error;
  console.error = function (...args) {
    const text = args.map((a) => (a && a.stack) || String(a)).join(' ');
    if (/^Warning:/.test(text) === false) window.__PREVIEW_ERRORS__.push(text.slice(0, 600));
    return realError.apply(console, args);
  };

  /* 冻结时钟：面板里有 agoText() 与 5s 轮询，不冻的话同一份数据在不同时刻截图
     会出现「12s 前 / 18s 前」的差别，改前改后就不可比了。 */
  const FROZEN = Number(new URLSearchParams(location.search).get('now') || ${Date.now()});
  const RealDate = Date;
  function FrozenDate(...args) {
    if (args.length === 0) return new RealDate(FROZEN);
    return new RealDate(...args);
  }
  FrozenDate.prototype = RealDate.prototype;
  FrozenDate.now = () => FROZEN;
  FrozenDate.parse = RealDate.parse;
  FrozenDate.UTC = RealDate.UTC;
  window.Date = FrozenDate;

  /* 把冻结点带给接口：fixture 里的相对时间要跟页面时钟同源，否则「6m 前」会漂。 */
  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (url.indexOf('/cluster-ui/api') === 0) {
      const sep = url.indexOf('?') >= 0 ? '&' : '?';
      return realFetch(url + sep + 'now=' + FROZEN, init);
    }
    return realFetch(input, init);
  };

  const captured = [];
  window.__ModuleLoader__ = { load(mod) { window.__MOD__ = mod; } };
  window.__CAPTURED__ = captured;
  window.__BOOT__ = (function () {
    let booted = false;
    return function boot() {
      if (booted) return true;
      const mod = window.__MOD__;
      if (!mod) return false;
      const require = (id) => {
        if (id === 'react') return window.React;
        throw new Error('preview harness: unsupported require(' + id + ')');
      };
      const exports = mod.factory(require);
      const ctx = {
        slots: {
          inject(_name, fn) { fn(); },
          register(spec, component) { captured.push({ spec, component }); return () => {}; },
        },
        layout: { selectPanel() {} },
        logger: { warn() {}, info() {}, error() {} },
      };
      exports.apply(ctx);
      window.__EXPORTS__ = exports;
      booted = true;
      return true;
    };
  })();
</script>
<script src="/bundle?which=${which}"></script>
<script>
  (function () {
    if (!window.__BOOT__()) { document.getElementById('host').textContent = 'bundle 未注册模块'; return; }
    const wanted = ${JSON.stringify(panel)};
    const row = window.__CAPTURED__.find((item) => item.spec.name === wanted || item.spec.id === wanted);
    if (!row) { document.getElementById('host').textContent = '没有注册 ' + wanted; return; }
    const Comp = row.component;
    const root = window.ReactDOM.createRoot(document.getElementById('host'));
    const props = wanted === 'settings.section' ? { close() {} } : {};
    root.render(window.React.createElement(Comp, props));
    window.__RENDERED__ = true;
  })();
</script>
</body>
</html>`

const SAMPLE_ROUTER_REPLY = (now) => ({
  role: 'router',
  text: '（预览环境）已收到。这里不会真的调用模型或网关。',
  ts: now,
  source: 'llm',
  model: 'deepseek-chat',
  elapsed_ms: 1234,
  usage: { inputTokens: 900, outputTokens: 40 },
  actions: [{ kind: 'tool', name: 'cluster_hosts', status: 'ok', elapsed_ms: 33 }],
})

/** 网关侧的只读/写入路由，形状对齐 cluster/ui_api.py。 */
function api(pathname, searchParams, method, now) {
  const f = fixturesFor(now)
  const key = pathname.replace(/^\/cluster-ui\/api/, '')
  if (method === 'POST') {
    if (key === '/router/message') return SAMPLE_ROUTER_REPLY(now)
    if (key === '/workspaces') return { workspace: { name: 'preview', roots: { 'win-node': 'S:\\cluster\\.state\\workspaces\\preview' } }, run: f.syncRuns.runs[0] }
    if (key === '/workspace/sync') return { run: f.syncRuns.runs[0] }
    if (key === '/workspace/sync/retry') return { run: f.syncRuns.runs[1], retried: 1 }
    return { ok: true }
  }
  switch (key) {
    case '/health':
      return f.health
    case '/hosts':
      return f.hosts
    case '/agents':
      return {
        items: f.hosts.items.flatMap((host) => host.agents.map((agent) => ({ ...agent, node_id: host.node_id, node_os: host.os }))),
        count: 10,
      }
    case '/tasks': {
      const limit = Number(searchParams.get('limit') || 10)
      return { ...f.tasks, items: f.tasks.items.slice(0, limit) }
    }
    case '/router/transcript':
      return f.transcript
    case '/router/status':
      return f.routerStatus
    case '/workspaces':
      return f.workspaces
    case '/workspace/sync/status': {
      const runId = searchParams.get('run_id')
      if (runId) {
        const run = f.syncRuns.runs.find((row) => row.id === runId)
        return { run: run || f.syncRuns.runs[0] }
      }
      return f.syncRuns
    }
    default:
      // 未知路由必须是非 2xx：否则「八条路由都返回 200」这类断言毫无判别力
      // （旧版本这里返回 200 + error 字段，把改名/拼错的路由也判成通过）。
      return { status: 404, body: { error: `preview harness: 未实现的只读路由 ${key}` } }
  }
}

function sendFile(res, path, type) {
  if (!existsSync(path)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`missing ${path}`)
    return
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
  createReadStream(path).pipe(res)
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const pathname = url.pathname

  if (pathname === '/' || pathname === '/index.html') {
    const which = url.searchParams.get('which') === 'baseline' ? 'baseline' : 'after'
    const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'
    const panel = url.searchParams.get('panel') || 'main'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE(which, theme, panel))
    return
  }
  if (pathname === '/tokens.css') return sendFile(res, join(here, 'tokens.css'), 'text/css; charset=utf-8')
  if (pathname === '/vendor/react.js') return sendFile(res, join(vendor, 'react.production.min.js'), 'text/javascript; charset=utf-8')
  if (pathname === '/vendor/react-dom.js') return sendFile(res, join(vendor, 'react-dom.production.min.js'), 'text/javascript; charset=utf-8')
  if (pathname === '/bundle') {
    const which = url.searchParams.get('which') === 'baseline' ? 'baseline' : 'after'
    const file = which === 'baseline' ? baseline.path : join(repo, 'dsh-plugin', 'lib', 'client.js')
    // 带上内容哈希：截图脚本据此断言 after 侧真的读到了工作区文件，
    // 而不是某个还在跑旧代码的服务进程。
    const text = readFileSync(file, 'utf8')
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-bundle-sha256': createHash('sha256').update(text).digest('hex'),
      'x-bundle-rev': which === 'baseline' ? baseline.rev : 'worktree',
    })
    res.end(text)
    return
  }
  if (pathname === '/manifest') {
    // 证据链：对比图副标题与 README 都读这里，保证「图上印的版本」= 「实际拍的那份代码」。
    const afterText = readFileSync(join(repo, 'dsh-plugin', 'lib', 'client.js'), 'utf8')
    const tokens = readFileSync(join(here, 'tokens.css'), 'utf8')
    const fixtureText = readFileSync(join(here, 'fixtures.mjs'), 'utf8')
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(
      JSON.stringify({
        baselineRev: baseline.rev,
        baselineSha256: baseline.sha,
        afterSha256: createHash('sha256').update(afterText).digest('hex'),
        tokensSha256: createHash('sha256').update(tokens).digest('hex'),
        fixturesSha256: createHash('sha256').update(fixtureText).digest('hex'),
        frozenClockMs: DEFAULT_NOW_MS,
      }),
    )
    return
  }
  if (pathname.startsWith('/cluster-ui/api')) {
    const nowMs = Number(url.searchParams.get('now') || DEFAULT_NOW_MS)
    const result = api(pathname, url.searchParams, req.method, secondsOf(nowMs))
    const status = result && typeof result.status === 'number' ? result.status : 200
    const body = result && typeof result.status === 'number' ? result.body : result
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

server.listen(PORT, '127.0.0.1', () => {
  const after = readFileSync(join(repo, 'dsh-plugin', 'lib', 'client.js'), 'utf8')
  const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)
  console.log(`cluster-ui preview on http://127.0.0.1:${PORT}/`)
  console.log(`  baseline = ${baseline.rev}:dsh-plugin/lib/client.js  sha256:${baseline.sha.slice(0, 16)}  (${statSync(baseline.path).size} bytes)`)
  console.log(`  after    = working tree                sha256:${sha(after)}  (${Buffer.byteLength(after)} bytes)`)
  if (baseline.sha === sha(after)) {
    console.log('  ⚠️ 两侧内容一致 —— 基线取错了，请检查 PREVIEW_BASELINE_REV')
  }
})
