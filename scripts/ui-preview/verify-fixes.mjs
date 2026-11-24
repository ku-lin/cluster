/**
 * 断言本次修复的四个点，逐条给出实测值（不是"看起来没问题"）。
 *
 *   1. 设置页真的把 --dcu-page 铺到了 background（浅色下卡片 ≠ 页面底色）
 *   2. Router 深色板里的错误块不再是一块白板
 *   3. 360 / 375px 窄屏没有横向溢出（这是本次引入过的回归）
 *   4. 健康总览换行后每行格宽相等、且行与行之间有横线
 *
 * 用法：node scripts/ui-preview/verify-fixes.mjs
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const wsEntry = join('S:', 'deepseek_harness', 'node_modules', 'ws', 'index.js')
const WebSocket = (await import(pathToFileURL(wsEntry).href)).default

const PORT = 9352
const NOW = 1795000000000
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
  ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(repo, '.cache', 'ui-harness', 'chrome-fix')}`, 'about:blank'],
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
  if (!r.exceptionDetails) return r.result.value
  // 把真实异常文本带出来，"EXC Uncaught" 这种信息量不够定位。
  const d = r.exceptionDetails
  return `EXC ${(d.exception && (d.exception.description || d.exception.value)) || d.text}`
}
const go = async (panel, w, h) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await page.send('Page.navigate', { url: `http://127.0.0.1:3899/?which=after&theme=light&panel=${panel}&now=${NOW}` })
  // 等真的挂载出来，而不是靠固定 sleep：设置页要发两次请求才出卡。
  const want = panel === 'settings.section' ? '.dcu-settings .dcu-card' : '.dcu-strip .dcu-stat'
  for (let i = 0; i < 40; i += 1) {
    const ready = await ev(`!!document.querySelector(${JSON.stringify(want)})`)
    if (ready === true) break
    await sleep(150)
  }
  await sleep(350)
}

const out = []
const check = (name, ok, detail) => {
  out.push({ name, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`)
}

// ---- 1 设置页底色 ----
await go('settings.section', 1440, 1000)
const settings = JSON.parse(
  await ev(`JSON.stringify((() => {
    const s = document.querySelector('.dcu-settings');
    const card = s.querySelector('.dcu-card');
    return {
      settingsBg: getComputedStyle(s).backgroundColor,
      cardBg: card ? getComputedStyle(card).backgroundColor : null,
      hostBg: getComputedStyle(document.body).backgroundColor,
    };
  })())`),
)
check(
  '设置页把 --dcu-page 铺到 background（不再透出 host 的白色）',
  settings.settingsBg !== 'rgba(0, 0, 0, 0)' && settings.settingsBg !== settings.cardBg,
  JSON.stringify(settings),
)
check('设置页卡片与页面底色不同（浅色下才有层次）', settings.cardBg !== settings.settingsBg, JSON.stringify(settings))

// ---- 2 Router 深色板里的错误块 ----
await go('main', 1440, 1000)
const routerErr = JSON.parse(
  await ev(`JSON.stringify((() => {
    document.querySelector('.dcu-router header button').click();
    return 'opened';
  })())`),
)
await sleep(450)
const errProbe = JSON.parse(
  await ev(`JSON.stringify((() => {
    const route = document.querySelector('.dcu-router');
    // 造一个错误块塞进 Router 内部，量它实际吃到的背景。
    const probe = document.createElement('div');
    probe.className = 'dcu-error';
    probe.textContent = 'probe';
    route.appendChild(probe);
    const bg = getComputedStyle(probe).backgroundColor;
    const alpha = Number((bg.match(/[\\d.]+\\)$/) || ['1)'])[0].replace(')', ''));
    probe.remove();
    return { bg, alpha, isWhite: /255,\\s*255,\\s*255/.test(bg) };
  })())`),
)
check('Router 深色板内的错误块不是白底', !errProbe.isWhite, JSON.stringify(errProbe))

// ---- 3 窄屏溢出（360 / 375 / 390 / 414）----
for (const w of [360, 375, 390, 414]) {
  await go('main', w, 900)
  const m = JSON.parse(
    await ev(`JSON.stringify((() => {
      const vw = document.documentElement.clientWidth;
      const body = document.querySelector('.dcu-body');
      const cards = [...document.querySelectorAll('.dcu-card')].map(el => Math.round(el.getBoundingClientRect().width));
      return { vw, docScroll: document.documentElement.scrollWidth, bodyH: body ? body.scrollWidth > body.clientWidth + 1 : null, cards };
    })())`),
  )
  check(`${w}px 首屏无横向溢出`, m.docScroll <= m.vw + 1 && m.bodyH !== true, JSON.stringify(m))
}

// ---- 4 换行后行内格宽相等 + 有横线 ----
for (const w of [1440, 1100, 719]) {
  await go('main', w, 900)
  const m = JSON.parse(
    await ev(`JSON.stringify((() => {
      const stats = [...document.querySelectorAll('.dcu-strip .dcu-stat')];
      const widths = stats.map(el => Math.round(el.getBoundingClientRect().width));
      const tops = [...new Set(stats.map(el => Math.round(el.getBoundingClientRect().top)))];
      const perRow = {};
      stats.forEach((el) => {
        const t = Math.round(el.getBoundingClientRect().top);
        perRow[t] = (perRow[t] || 0) + 1;
      });
      const rows = Object.values(perRow);
      const widthsPerRow = tops.map((t) => [...new Set(stats.filter(el => Math.round(el.getBoundingClientRect().top) === t).map(el => Math.round(el.getBoundingClientRect().width)))]);
      const cs = getComputedStyle(stats[0]);
      return {
        widths, rows, widthsPerRow,
        borderBottom: cs.borderBottomWidth,
        borderRight: cs.borderRightWidth,
      };
    })())`),
  )
  const equalPerRow = m.widthsPerRow.every((g) => g.length <= 1)
  const hasRowLines = m.borderBottom !== '0px' && m.borderRight !== '0px'
  check(`${w}px 每行格宽相等（rows=${JSON.stringify(m.rows)}）`, equalPerRow, JSON.stringify(m.widthsPerRow))
  check(`${w}px 行与行之间有横线`, hasLine(m.borderBottom) && hasLine(m.borderRight), `borderBottom=${m.borderBottom} borderRight=${m.borderRight}`)
}

function hasLine(v) {
  return v && v !== '0px'
}

page.close()
browser.close()
child.kill()

const failed = out.filter((r) => !r.ok)
console.log(`\n${out.length - failed.length}/${out.length} 通过`)
if (failed.length) process.exitCode = 1
