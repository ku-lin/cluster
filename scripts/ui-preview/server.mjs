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
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
 * 现在钉的是 751ea01（ui 1.1.0 定版那一提交）。换基线改这里，同时改
 * EVIDENCE_DIR，两者要一起走，否则新截图会写进旧证据目录、跟旧图混在一起。
 */
const BASELINE_REV = process.env.PREVIEW_BASELINE_REV || '751ea01'

/**
 * 证据目录。默认指向本次（ui-1.2.0），**不再指 ui-1.1.0**：
 * 旧目录是上一版留下的历史证据，重新截图会覆盖掉它们，历史对比就没了。
 */
const EVIDENCE_DIR =
  process.env.PREVIEW_EVIDENCE_DIR || join(repo, 'docs', 'evidence', 'ui-1.2.0')

/** 解析一次提交：必须存在，且里面必须有插件客户端；否则宁可起不来，也别偷偷拍错图。 */
function resolveCommit(rev) {
  const git = (args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim()
  let sha
  try {
    sha = git(['rev-parse', '--verify', `${rev}^{commit}`])
  } catch {
    throw new Error(`基线提交 ${rev} 在仓库里不存在（preview harness 拒绝启动）`)
  }
  let subject = ''
  try {
    subject = git(['log', '-1', '--format=%s', sha])
  } catch {
    /* 无提交信息不影响可用性 */
  }
  return { rev, fullSha: sha, subject }
}

/** 把 BASELINE_REV 里那一版 client.js 落到 .cache，供 baseline 直接取用。 */
function materializeBaseline() {
  const commit = resolveCommit(BASELINE_REV)
  const sourceRoot = process.env.PREVIEW_BASELINE_WORKTREE
  if (sourceRoot) {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
    if (head !== commit.fullSha || dirty) throw new Error('基线 worktree 必须干净且 HEAD 等于指定提交')
    const path = join(sourceRoot, 'dsh-plugin', 'lib', 'client.js')
    const bytes = readFileSync(path)
    return {
      path, rev: commit.rev, fullSha: head, subject: commit.subject,
      source: 'git-worktree', sourceRoot,
      sha: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    }
  }
  const cache = join(repo, '.cache', 'ui-harness', `baseline-${commit.fullSha.slice(0, 7)}`)
  mkdirSync(cache, { recursive: true })
  const out = join(cache, 'client.js')
  let text
  try {
    text = execFileSync('git', ['show', `${commit.fullSha}:dsh-plugin/lib/client.js`], {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch {
    throw new Error(
      `基线提交 ${BASELINE_REV} 里没有 dsh-plugin/lib/client.js（preview harness 拒绝启动）`,
    )
  }
  writeFileSync(out, text, 'utf8')
  return {
    path: out,
    rev: commit.rev,
    fullSha: commit.fullSha,
    subject: commit.subject,
    source: 'git-show',
    sha: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text),
  }
}

const baseline = materializeBaseline()

/** 工作区那份 after 的身份。每次请求现读，避免"服务起着、文件改了"时读到旧的哈希。 */
function afterIdentity() {
  const path = join(repo, 'dsh-plugin', 'lib', 'client.js')
  const text = readFileSync(path, 'utf8')
  return {
    path,
    sha: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text),
    worktree: (() => {
      try {
        return execFileSync('git', ['status', '--porcelain', '--', 'dsh-plugin/lib/client.js'], {
          cwd: repo,
          encoding: 'utf8',
        }).trim()
      } catch {
        return ''
      }
    })(),
  }
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/**
 * 身份清单：一张截图到底是"哪份代码 + 哪份 token + 哪份 fixture"拍的，全在这里。
 *
 * 刻意不含时间戳与主机名 —— 同样的输入重复跑应当得到**逐字节相同**的清单，
 * 这样两份产物可以直接 diff 出"代码变了"还是"环境变了"。
 */
function manifest() {
  const after = afterIdentity()
  return {
    schema: 'ui-preview/manifest/2',
    evidenceDir: EVIDENCE_DIR.replace(/\\/g, '/').replace(`${repo.replace(/\\/g, '/')}/`, ''),
    baseline: {
      rev: baseline.rev,
      fullSha: baseline.fullSha,
      subject: baseline.subject,
      source: baseline.source,
      sourceRoot: baseline.sourceRoot || null,
      clientSha256: baseline.sha,
      clientBytes: baseline.bytes,
    },
    after: {
      clientSha256: after.sha,
      clientBytes: after.bytes,
      worktreeDirty: after.worktree !== '',
    },
    // 兼容 1.x 的键名：compose/README 与历史对比图副标题读的是这几个。
    baselineRev: baseline.rev,
    baselineSha256: baseline.sha,
    afterSha256: after.sha,
    tokensSha256: sha256(readFileSync(join(here, 'tokens.css'), 'utf8')),
    fixturesSha256: sha256(readFileSync(join(here, 'fixtures.mjs'), 'utf8')),
    frozenClockMs: DEFAULT_NOW_MS,
    harness: {
      node: process.version,
      port: PORT,
    },
  }
}

/**
 * 把「这次真正发给浏览器的 bundle 哈希」写进页面。
 *
 * 为什么非要多这一层：`/identity` 是**服务端自己声称**的哈希，`x-bundle-sha256`
 * 是**响应头声称**的哈希；两者都可能对，而页面里跑的却仍是上一份文档缓存下来的
 * 旧脚本。只有让页面把脚本实际收到的内容报告回来，才能证明「图上画的是这份代码」。
 * shoot.mjs 会读页面里这颗 meta（preview-expected-bundle-sha256），与 /identity、
 * 以及注入样式表的哈希三者对账。
 */
const PAGE = (which, theme, panel, bundleSha) => `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8" />
<title>cluster-ui preview · ${which} · ${theme}</title>
<!-- 期望值先落进页面：截图脚本据此核对「浏览器真跑的那份脚本」与「服务声称的那份」是否同一份。 -->
<meta name="preview-expected-bundle-sha256" content="${bundleSha}" />
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

/**
 * 某一侧的 bundle 文件路径。`/`、`/bundle` 与 `/identity` 共用这一处，
 * 避免"页面写的期望值"和"实际发出的字节"各自解析路径、悄悄指向不同文件。
 */
function bundleFile(which) {
  return which === 'baseline' ? baseline.path : join(repo, 'dsh-plugin', 'lib', 'client.js')
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const pathname = url.pathname

  if (pathname === '/' || pathname === '/index.html') {
    const which = url.searchParams.get('which') === 'baseline' ? 'baseline' : 'after'
    const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'
    const panel = url.searchParams.get('panel') || 'main'
    /**
     * 页面里写下的「期望 bundle 哈希」必须与接下来真正要发出去的那份一致。
     * 这里**现读文件**（与 /bundle 同一份读取函数），而不是复用启动时的快照：
     * 截图跑在文件改动之后、服务重启之前的那种情形，才不会一边发新字节、一边写旧期望值。
     */
    const bundleSha = sha256(readFileSync(bundleFile(which), 'utf8'))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE(which, theme, panel, bundleSha))
    return
  }
  if (pathname === '/tokens.css') return sendFile(res, join(here, 'tokens.css'), 'text/css; charset=utf-8')
  if (pathname === '/vendor/react.js') return sendFile(res, join(vendor, 'react.production.min.js'), 'text/javascript; charset=utf-8')
  if (pathname === '/vendor/react-dom.js') return sendFile(res, join(vendor, 'react-dom.production.min.js'), 'text/javascript; charset=utf-8')
  if (pathname === '/bundle') {
    const which = url.searchParams.get('which') === 'baseline' ? 'baseline' : 'after'
    const file = bundleFile(which)
    // 带上内容哈希：截图脚本据此断言 after 侧真的读到了工作区文件，
    // 而不是某个还在跑旧代码的服务进程。
    const text = readFileSync(file, 'utf8')
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-bundle-sha256': sha256(text),
      'x-bundle-rev': which === 'baseline' ? baseline.rev : 'worktree',
    })
    res.end(text)
    return
  }
  if (pathname === '/manifest' || pathname === '/identity') {
    // 证据链：截图脚本把这份清单连同每张 PNG 的 sha256 一起落盘；compose 只读
    // **已落盘的那份**，不再实时问服务 —— 否则拿今天的服务去标注上周的截图。
    const body = pathname === '/identity' ? { ...manifest(), evidenceDirAbs: EVIDENCE_DIR } : manifest()
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body, null, 2))
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
  const after = afterIdentity()
  const short = (h) => String(h || '').slice(0, 16)
  console.log(`cluster-ui preview on http://127.0.0.1:${PORT}/`)
  console.log(`  baseline = ${baseline.rev} (${baseline.fullSha.slice(0, 7)})  sha256:${short(baseline.sha)}  (${baseline.bytes} bytes)`)
  console.log(`  after    = working tree${after.worktree ? ' (dirty)' : ''}         sha256:${short(after.sha)}  (${after.bytes} bytes)`)
  console.log(`  evidence = ${EVIDENCE_DIR.replace(/\\/g, '/')}/`)
  // 两侧哈希相同 = 基线根本没钉住（或工作区就是基线那一版），图上看不出来，必须喊出来。
  if (baseline.sha === after.sha) {
    console.log('  ⚠️ 两侧内容一致 —— 基线取错了，请检查 PREVIEW_BASELINE_REV')
  }
})
