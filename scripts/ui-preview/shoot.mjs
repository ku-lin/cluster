/**
 * 用 CDP 驱动一个一次性 headless Chrome，把 panel 在若干「同场景」下截成 PNG。
 *
 * 为什么要 CDP 而不是 `chrome --screenshot`：对比图里不能只有默认首屏——展开的
 * 明细、工作区同步页、设置页都是这次改动的目标，而 `--screenshot` 没法点。这里
 * 每个场景都有一条确定的操作序列（点哪个 selector、等几帧），改前改后跑同一份。
 *
 * 用法：
 *   node scripts/ui-preview/shoot.mjs --which baseline --out docs/evidence/ui-1.1.0/before
 *   node scripts/ui-preview/shoot.mjs --which after    --out docs/evidence/ui-1.1.0/after
 *
 * 视口固定 1440×1000、DPR 1；时钟由页面按 ?now= 冻结（毫秒），滚动条隐藏，两者同源。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')

// ws 从 DSH 的 node_modules 里借（本仓库不装 node_modules）；Windows 绝对路径
// 必须转成 file:// URL，否则 ESM loader 会把 `S:` 当未知协议拒掉。
const wsEntry = join('S:', 'deepseek_harness', 'node_modules', 'ws', 'index.js')
const WebSocket = (await import(pathToFileURL(wsEntry).href)).default

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}

const which = arg('which', 'after')
const outDir = arg('out', join(repo, 'docs', 'evidence', 'ui-1.1.0', which))
const base = arg('base', 'http://127.0.0.1:3899')
const chromePath = arg('chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
// 冻在同一个毫秒上，改前改后同值——`agoText()` 才有相同输出。
const FROZEN = Number(arg('now', '1795000000000'))
const PORT = Number(arg('port', '9333'))
const WIDTH = Number(arg('width', '1440'))
const HEIGHT = Number(arg('height', '1000'))

/** 场景：URL 参数 + 操作序列。selector 直接给 CSS，文本匹配单独走 clickText。 */
const SCENES = [
  {
    id: 'overview-light',
    theme: 'light',
    steps: [],
  },
  {
    id: 'overview-dark',
    theme: 'dark',
    steps: [],
  },
  {
    id: 'overview-expanded-light',
    theme: 'light',
    // 展开节点卡明细后滚到底：展开的内容在折线下方，不滚就跟折叠态截图没有区别。
    steps: [
      { click: '#host article.dcu-card:nth-of-type(1) details.dcu-fold > summary' },
      { wait: 350 },
      { scroll: 'bottom' },
      { wait: 350 },
    ],
  },
  {
    id: 'overview-router-open-light',
    theme: 'light',
    // Router 展开：验证深色块、长中文回复、动作小标签都没被压坏。
    steps: [
      { click: '#host section.dcu-router header button' },
      { wait: 450 },
    ],
  },
  {
    id: 'sync-tab-light',
    theme: 'light',
    steps: [{ clickText: '工作区同步' }, { wait: 800 }],
  },
  {
    id: 'settings-light',
    theme: 'light',
    panel: 'settings.section',
    steps: [{ wait: 500 }],
  },
]

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let id = 0
    const pending = new Map()
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: bad } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) bad(new Error(`${msg.error.message} (${JSON.stringify(msg.error)})`))
        else ok(msg.result)
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
        close() {
          ws.close()
        },
      }),
    )
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForDevtools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return (await res.json()).webSocketDebuggerUrl
    } catch {
      /* 还没起来 */
    }
    await sleep(200)
  }
  throw new Error('devtools 没起来')
}

/** 在页面里跑一段表达式并把返回值读回来（失败不抛，让场景继续）。 */
async function evaluate(page, expression) {
  const out = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (out.exceptionDetails) {
    return { error: out.exceptionDetails.text || 'exception', value: null }
  }
  return { error: null, value: out.result ? out.result.value : null }
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  const profile = join(repo, '.cache', 'ui-harness', `chrome-${which}`)
  const child = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--disable-lcd-text',
      '--font-render-hinting=none',
      '--disable-features=CalculateNativeWinOcclusion',
      `--window-size=${WIDTH},${HEIGHT}`,
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  const browserWs = await waitForDevtools(PORT)
  const browser = await connect(browserWs)
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const pageTarget = list.find((t) => t.id === targetId)
  const page = await connect(pageTarget.webSocketDebuggerUrl)

  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  })

  const shots = []
  const problems = []

  for (const scene of SCENES) {
    const panel = scene.panel || 'main'
    const url = `${base}/?which=${which}&theme=${scene.theme}&panel=${panel}&now=${FROZEN}`
    await page.send('Page.navigate', { url })
    // 等 React 首帧 + fixtures 落地，再执行场景操作。
    await sleep(1200)

    for (const step of scene.steps || []) {
      if (step.click) {
        const out = await evaluate(
          page,
          `(() => { const el = document.querySelector(${JSON.stringify(step.click)}); if (!el) return 'MISS'; el.click(); return 'ok' })()`,
        )
        if (out.value !== 'ok') problems.push(`${scene.id}: 点不到 ${step.click} (${out.value || out.error})`)
      }
      if (step.clickText) {
        const out = await evaluate(
          page,
          `(() => { const els = [...document.querySelectorAll('button')]; const el = els.find((b) => b.textContent.trim() === ${JSON.stringify(step.clickText)}); if (!el) return 'MISS'; el.click(); return 'ok' })()`,
        )
        if (out.value !== 'ok') problems.push(`${scene.id}: 点不到按钮「${step.clickText}」 (${out.value || out.error})`)
      }
      if (step.wait) await sleep(step.wait)
      if (step.scroll) {
        const out = await evaluate(
          page,
          `(() => { const el = document.querySelector('.dcu-body'); if (!el) return 'MISS'; el.scrollTop = el.scrollHeight; return 'ok' })()`,
        )
        if (out.value !== 'ok') problems.push(`${scene.id}: 滚不到底 (${out.value || out.error})`)
      }
    }

    await sleep(400)

    // 页面是否真的画出了东西：根节点里得有可见子元素，否则截图"整洁"但其实是空白。
    const painted = await evaluate(
      page,
      `(() => { const host = document.getElementById('host'); const root = host && host.firstElementChild; if (!root) return 0; return root.querySelectorAll('*').length })()`,
    )
    if (!painted.value) problems.push(`${scene.id}: 根节点没有内容（渲染失败）`)

    const errs = await evaluate(page, `JSON.stringify(window.__PREVIEW_ERRORS__ || [])`)
    if (errs.value && errs.value !== '[]') problems.push(`${scene.id}: 运行时错误 ${errs.value}`)

    const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = join(outDir, `${scene.id}.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    shots.push({ id: scene.id, file, url })
    console.log(`  ${scene.id}.png  (${painted.value} nodes)`)
  }

  await page.send('Page.navigate', { url: 'about:blank' })
  page.close()
  browser.close()
  child.kill()

  console.log(`\n${shots.length} shots -> ${outDir}`)
  if (problems.length) {
    console.log('\n问题：')
    for (const p of problems) console.log(`  - ${p}`)
    process.exitCode = 1
  } else {
    console.log('场景全部渲染成功，无运行时错误。')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
