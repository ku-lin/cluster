/**
 * 把 before/after 同名截图拼成一张"改前 | 改后"对比图，并在上方标注版本。
 *
 * 为什么用 canvas 自己实现而不是 ImageMagick：这台机器上没装，而 libvips/sharp
 * 只为拼图引一个原生依赖不值得。这里用 Chrome 渲染一个 HTML 拼版再截图，顺带让
 * 标注文字也用与界面一致的无衬线字体。
 *
 * 用法：
 *   node scripts/ui-preview/compose.mjs                 # 拼 ui-1.2.0 的全部场景
 *   node scripts/ui-preview/compose.mjs --verify-only   # 只复核哈希，不拼图
 *
 * 版本标注读的是 shoot.mjs 在拍摄时**落盘**的 before/manifest.json，不再实时问服务。
 * 踩过的坑：早期版本每次拼图都现取 /manifest，历史截图的副标题会被后来重启的服务
 * 改标 —— 图上印的"基线"和图里实际拍的代码就脱钩了。现在拍摄即存证，拼图只认账。
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const wsEntry = join('S:', 'deepseek_harness', 'node_modules', 'ws', 'index.js')
const WebSocket = (await import(pathToFileURL(wsEntry).href)).default

const argv = process.argv.slice(2)
const VERIFY_ONLY = argv.includes('--verify-only')
const EVID_ARG = (() => {
  const i = argv.indexOf('--evid')
  return i >= 0 ? argv[i + 1] : 'docs/evidence/ui-1.2.0'
})()
const EVID = join(repo, EVID_ARG)
const PORT = 9342
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SCENES = [
  { id: 'overview-light', title: '总览 · 浅色', note: '首屏默认态' },
  { id: 'overview-dark', title: '总览 · 暗色', note: '同一份数据，暗色主题' },
  { id: 'overview-expanded-light', title: '总览 · 展开节点明细（滚到底）', note: '趋势图 / 能力列表' },
  { id: 'overview-router-open-light', title: 'Router 对话展开', note: '深色板 + 长中文回复' },
  { id: 'sync-tab-light', title: '工作区同步页', note: '第二个标签页' },
  { id: 'settings-light', title: '设置页 Cluster 板块', note: 'DSH 设置页内的落点' },
]

/** 拍摄时落盘的身份清单：拼图副标题与复核都以它为准，不再问服务。 */
function loadShotManifest(dir) {
  const file = join(dir, 'manifest.json')
  if (!existsSync(file)) {
    throw new Error(
      `缺 ${EVID_ARG}\\${dir.endsWith('before') ? 'before' : 'after'}\\manifest.json —— 这份截图没带身份，` +
        '不能进对比图。用新版 shoot.mjs 重新拍。',
    )
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}

function verifyShots(dir, label) {
  const doc = loadShotManifest(dir)
  const problems = []
  for (const shot of doc.shots) {
    const png = join(dir, `${shot.id}.png`)
    if (!existsSync(png)) {
      problems.push(`${label}/${shot.id}.png 不在盘上`)
      continue
    }
    const actual = createHash('sha256').update(readFileSync(png)).digest('hex')
    if (actual !== shot.pngSha256) {
      problems.push(
        `${label}/${shot.id}.png 哈希不符\n    manifest ${shot.pngSha256}\n    实际     ${actual} —— 图被改过或换过`,
      )
    }
  }
  return { doc, problems }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let id = 0
    const pending = new Map()
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
      }
    })
    ws.on('error', reject)
    ws.on('open', () =>
      resolve({
        send(method, params) {
          id += 1
          ws.send(JSON.stringify({ id, method, params: params || {} }))
          return new Promise((ok, bad) => pending.set(id, { resolve: ok, reject: bad }))
        },
        close: () => ws.close(),
      }),
    )
  })
}

const b64 = (path) => `data:image/png;base64,${readFileSync(path).toString('base64')}`

const beforeResult = verifyShots(join(EVID, 'before'), 'before')
const hasAfter = existsSync(join(EVID, 'after', 'manifest.json'))
const afterResult = hasAfter ? verifyShots(join(EVID, 'after'), 'after') : null
const problems = [...beforeResult.problems, ...(afterResult?.problems || [])]
const beforeDoc = beforeResult.doc
const afterDoc = afterResult?.doc
const ids = SCENES.map(s => s.id).sort().join(',')
for (const doc of [beforeDoc, afterDoc].filter(Boolean)) {
  if (doc.shots.map(s => s.id).sort().join(',') !== ids) problems.push('Scene inventory mismatch')
  if (doc.server.baseline.rev !== '751ea01') problems.push('Expected baseline 751ea01')
}
if (beforeDoc.which !== 'baseline' || (afterDoc && afterDoc.which !== 'after')) problems.push('Wrong capture side')
if (afterDoc) {
  for (const key of ['tokensSha256', 'fixturesSha256']) {
    if (beforeDoc.server[key] !== afterDoc.server[key]) problems.push(`Different ${key}`)
  }
  for (const key of ['capturedViewport', 'frozenClockMs']) {
    if (JSON.stringify(beforeDoc[key]) !== JSON.stringify(afterDoc[key])) problems.push(`Different ${key}`)
  }
}
if (problems.length) throw new Error(problems.join('\n'))
console.log(`Verified ${beforeDoc.shots.length + (afterDoc?.shots.length || 0)} PNG hashes`)
if (VERIFY_ONLY) process.exit(0)
if (!afterDoc) throw new Error('Capture after first; before-only verification passed')
const manifest = {
  baselineRev: beforeDoc.server.baseline.rev,
  baselineSha256: beforeDoc.server.baseline.clientSha256,
  afterSha256: afterDoc.server.after.clientSha256,
  tokensSha256: beforeDoc.server.tokensSha256,
  fixturesSha256: beforeDoc.server.fixturesSha256,
  frozenClockMs: beforeDoc.frozenClockMs,
}

const short = (h, n = 10) => String(h || '').slice(0, n)

function page(scene) {
  const before = join(EVID, 'before', `${scene.id}.png`)
  const after = join(EVID, 'after', `${scene.id}.png`)
  if (!existsSync(before) || !existsSync(after)) throw new Error(`缺图: ${scene.id}`)
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0d10; color: #e8eaed; font: 400 14px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .wrap { padding: 26px 30px 30px; }
  h1 { font-size: 19px; font-weight: 650; margin: 0 0 4px; letter-spacing: -.01em; }
  .sub { font-size: 12.5px; color: #9aa0a6; margin-bottom: 6px; }
  .sub.meta { margin-bottom: 20px; font-size: 11.5px; color: #7f858c; }
  .sub code { color: #c8cdd3; background: #1a1e23; padding: 1px 6px; border-radius: 5px; font-size: 11.5px; font-family: ui-monospace, Menlo, monospace; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .tag { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 600; letter-spacing: .02em; }
  .tag i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .tag.before { color: #b6bcc4; } .tag.before i { background: #6b7280; }
  .tag.after { color: #7fd0a3; } .tag.after i { background: #34d17e; }
  .col img { width: 100%; display: block; border-radius: 9px; border: 1px solid #262b31; background: #fff; }
</style></head>
<body><div class="wrap">
  <h1>${scene.title}</h1>
  <div class="sub">${scene.note} · 1440×1000 · 同一份 fixture 数据 · 冻结时钟 ${manifest.frozenClockMs}</div>
  <div class="sub meta">
    改前 client.js <code>${short(manifest.baselineSha256)}</code>（提交 <code>${manifest.baselineRev}</code>）
    &nbsp;·&nbsp; 改后 client.js <code>${short(manifest.afterSha256)}</code>
    &nbsp;·&nbsp; tokens <code>${short(manifest.tokensSha256, 8)}</code>
    &nbsp;·&nbsp; fixtures <code>${short(manifest.fixturesSha256, 8)}</code>
  </div>
  <div class="pair">
    <div class="col"><span class="tag before"><i></i>改前（提交 ${manifest.baselineRev}）</span><img src="${b64(before)}" /></div>
    <div class="col"><span class="tag after"><i></i>改后（本次工作区）</span><img src="${b64(after)}" /></div>
  </div>
</div></body></html>`
}

const child = spawn(
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(repo, '.cache', 'ui-harness', 'chrome-compose')}`, 'about:blank'],
  { stdio: 'ignore' },
)
for (let i = 0; i < 80; i += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break
  } catch {
    /* 等 */
  }
  await sleep(200)
}
const browser = await connect((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl)
const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pageTarget = list.find((t) => t.id === targetId)
const conn = await connect(pageTarget.webSocketDebuggerUrl)
await conn.send('Page.enable')
await conn.send('Runtime.enable')

const outDir = join(EVID, 'compare')
mkdirSync(outDir, { recursive: true })

const tmpDir = join(repo, '.cache', 'ui-harness', 'compose-html')
mkdirSync(tmpDir, { recursive: true })

// 两张 1440 宽的图并排 + 间距/内边距：视口先给够，否则栅格会塌成单列。
const VIEWPORT_W = 3020
await conn.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT_W, height: 1200, deviceScaleFactor: 1, mobile: false })

for (const scene of SCENES) {
  const html = join(tmpDir, `${scene.id}.html`)
  writeFileSync(html, page(scene), 'utf8')
  await conn.send('Page.navigate', { url: pathToFileURL(html).href })
  await sleep(600)
  // 等两张内联图真正解码完再量高度：图没加载时 scrollHeight 只有页头那么高，
  // 量出来的视口会把下半截裁掉。
  await conn.send('Runtime.evaluate', {
    expression: `(async () => { await Promise.all([...document.images].map(i => i.decode().catch(() => {}))); })()`,
    awaitPromise: true,
  })
  await sleep(400)
  const metrics = await conn.send('Runtime.evaluate', {
    expression: `JSON.stringify({ w: Math.ceil(document.body.scrollWidth), h: Math.ceil(document.body.scrollHeight) })`,
    returnByValue: true,
  })
  const { w, h } = JSON.parse(metrics.result.value)
  await conn.send('Emulation.setDeviceMetricsOverride', { width: Math.max(w, VIEWPORT_W), height: h, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
  const shot = await conn.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const png = Buffer.from(shot.data, 'base64')
  const file = join(outDir, `${scene.id}.png`)
  writeFileSync(file, png)
  console.log(`  ${scene.id}.png  ${w}x${h}  sha256:${createHash('sha256').update(png).digest('hex').slice(0, 16)}`)
}

conn.close()
browser.close()
child.kill()

// 对比图自己也带一份小清单：每张对比 PNG 的哈希 + 它引用的 before/after 清单哈希。
const compareManifest = {
  schema: 'ui-preview/compare/1',
  evidenceDir: EVID_ARG,
  baselineRev: manifest.baselineRev,
  baselineClientSha256: manifest.baselineSha256,
  afterClientSha256: manifest.afterSha256,
  tokensSha256: manifest.tokensSha256,
  fixturesSha256: manifest.fixturesSha256,
  frozenClockMs: manifest.frozenClockMs,
  sources: {
    beforeManifest: createHash('sha256').update(readFileSync(join(EVID, 'before', 'manifest.json'))).digest('hex'),
    afterManifest: createHash('sha256').update(readFileSync(join(EVID, 'after', 'manifest.json'))).digest('hex'),
  },
  images: SCENES.map((s) => {
    const f = join(outDir, `${s.id}.png`)
    return { id: s.id, file: `${EVID_ARG}/compare/${s.id}.png`, pngSha256: createHash('sha256').update(readFileSync(f)).digest('hex') }
  }),
}
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(compareManifest, null, 2)}\n`, 'utf8')
console.log(`\n对比图 -> ${outDir}`)
console.log(`manifest -> ${join(outDir, 'manifest.json')}`)
