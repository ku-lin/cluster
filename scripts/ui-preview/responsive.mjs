/**
 * 响应式验证：在几个常见宽度下检查有没有横向溢出 / 元素跑出视口。
 *
 * 判据用「根节点 scrollWidth 是否超过 clientWidth」+「有没有元素右边界超出视口」。
 * 这一步是必须的：这一版把内容区上限设成 1480px、健康总览改成 5 列栅格，
 * 窄屏下最容易出横向滚动条。
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const wsEntry = join('S:', 'deepseek_harness', 'node_modules', 'ws', 'index.js')
const WebSocket = (await import(pathToFileURL(wsEntry).href)).default

const PORT = 9343
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const child = spawn(
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(repo, '.cache', 'ui-harness', 'chrome-resp')}`, 'about:blank'],
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
const page = await connect(list.find((t) => t.id === targetId).webSocketDebuggerUrl)
await page.send('Runtime.enable')

const ev = async (e) => {
  const r = await page.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  return r.exceptionDetails ? `EXC ${r.exceptionDetails.text}` : r.result.value
}

// 360/375 是必须的：手机竖屏最常见宽度，且 `.dcu-cards` 的 minmax(360px,1fr)
// 在 375px 下会撑出横向滚动条。之前下限只到 480px，正好漏掉了这段真实区间。
const WIDTHS = [1600, 1440, 1280, 1100, 900, 760, 620, 480, 414, 390, 375, 360]
const which = process.argv.includes('--baseline') ? 'baseline' : 'after'
const results = []

for (const w of WIDTHS) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false })
  await page.send('Page.navigate', { url: `http://127.0.0.1:3899/?which=${which}&theme=light&now=1795000000000` })
  await sleep(1300)
  const m = await ev(`JSON.stringify((() => {
    const root = document.getElementById('host').firstElementChild;
    const body = document.querySelector('.dcu-body');
    const vw = document.documentElement.clientWidth;
    const escapes = [];
    for (const el of root.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) escapes.push((el.className || el.tagName).toString().slice(0, 32));
    }
    // 列数从实际 grid 轨道算；元素不存在时给 null，避免 getComputedStyle(null) 抛错
    // （1.2.0 起 .dcu-charts 已并入工作台主列，不再是独立容器）。
    const cols = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const rows = getComputedStyle(el).gridTemplateColumns;
      return rows && rows !== 'none' ? rows.split(' ').length : null;
    };
    return {
      vw,
      hScroll: document.documentElement.scrollWidth > vw + 1,
      bodyHScroll: body ? body.scrollWidth > body.clientWidth + 1 : null,
      escapes: [...new Set(escapes)].slice(0, 5),
      statCols: cols('.dcu-strip'),
      workbenchCols: cols('.dcu-workbench'),
      opsCols: cols('.dcu-operations'),
    };
  })())`)
  const o = JSON.parse(m)
  const ok = !o.hScroll && !o.bodyHScroll && o.escapes.length === 0
  results.push({ w, ok, ...o })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${String(w).padStart(4)}px  指标条=${o.statCols}列 工作台=${o.workbenchCols}列${ok ? '' : `  <- 横向溢出: ${JSON.stringify(o)}`}`)
}

page.close()
browser.close()
child.kill()

const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length}/${results.length} 宽度无溢出`)
if (bad.length) process.exitCode = 1
