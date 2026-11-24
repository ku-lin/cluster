/**
 * 把 before/after 同名截图拼成一张"改前 | 改后"对比图，并在上方标注版本。
 *
 * 为什么用 canvas 自己实现而不是 ImageMagick：这台机器上没装，而 libvips/sharp
 * 只为拼图引一个原生依赖不值得。这里用 Chrome 渲染一个 HTML 拼版再截图，顺带让
 * 标注文字也用与界面一致的无衬线字体。
 *
 * 用法：node scripts/ui-preview/compose.mjs
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const wsEntry = join('S:', 'deepseek_harness', 'node_modules', 'ws', 'index.js')
const WebSocket = (await import(pathToFileURL(wsEntry).href)).default

const EVID = join(repo, 'docs', 'evidence', 'ui-1.1.0')
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

const rev = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  } catch {
    return 'HEAD'
  }
})()

/**
 * 版本标注不再取"当前 HEAD"，而是问预览服务要 /manifest。
 *
 * 踩过的坑：最初副标题印 `git rev-parse HEAD`，而 baseline 快照是在**服务启动时**
 * 用 `HEAD:...` 取的。服务先起、期间 HEAD 变了，图上就会标一个不是实际拍到的基线。
 * 现在基线提交写死在 server.mjs 的 BASELINE_REV 里，两张图各自的内容哈希由服务
 * 返回，图上的字因此可被独立复核。
 */
const manifest = await (async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${process.env.PREVIEW_PORT || 3899}/manifest`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (error) {
    throw new Error(`取 /manifest 失败（预览服务没起？）：${error.message}`)
  }
})()

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
  const file = join(outDir, `${scene.id}.png`)
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  console.log(`  ${scene.id}.png  ${w}x${h}`)
}

conn.close()
browser.close()
child.kill()
console.log(`\n对比图 -> ${outDir}`)
