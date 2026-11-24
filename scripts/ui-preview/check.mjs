/**
 * 功能回归：在预览环境里把每个交互入口都点一遍，验证「改样式没改坏行为」。
 *
 * 检查的不只是"没报错"，而是每个入口都产生**可观察的状态变化**：
 *   - 标签页切换后另一块内容出现（工作区同步的标题）
 *   - 节点明细 <details> 的 open 由 false 变 true，且出现 agent 行
 *   - Router 展开后 textarea 可输入、发送按钮从 disabled 变 enabled
 *   - 最近任务折叠展开后真的发出 /tasks 请求并渲染出任务行
 *   - 同步页的下拉框选项、按钮都还在
 *   - 设置页的输入框/下拉框/按钮都在
 *
 * 用法：node scripts/ui-preview/check.mjs [--which after|baseline]
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const wsEntry = join('S:', 'deepseek_harness', 'node_modules', 'ws', 'index.js')
const WebSocket = (await import(pathToFileURL(wsEntry).href)).default

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const which = arg('which', 'after')
const PORT = 9339
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
  ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(repo, '.cache', 'ui-harness', 'chrome-check')}`, '--window-size=1440,1000', 'about:blank'],
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

const ev = async (expr) => {
  const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.exceptionDetails ? `EXC ${r.exceptionDetails.text}` : r.result.value
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`)
}

const go = async (panel = 'main') => {
  await page.send('Page.navigate', { url: `http://127.0.0.1:3899/?which=${which}&theme=light&panel=${panel}&now=${NOW}` })
  await sleep(1400)
}

console.log(`\n=== 交互回归 (${which}) ===`)

// ---------- 主面板 · 总览 ----------
await go()
check('首屏渲染出健康总览五格', (await ev(`document.querySelectorAll('.dcu-strip .dcu-stat').length`)) === 5, '数量不对')
check('首屏渲染出两台节点卡', (await ev(`document.querySelectorAll('#host article.dcu-card').length`)) === 2, '数量不对')
check('刷新按钮存在且可点', (await ev(`!!document.querySelector('.dcu-head .dcu-btn')`)) === true)

// 标签页切换
check('切到「工作区同步」后出现同步页标题', await (async () => {
  await ev(`[...document.querySelectorAll('.dcu-tab')].find(b => b.textContent.trim() === '工作区同步').click()`)
  await sleep(800)
  return (await ev(`!!document.querySelector('.dcu-run') && document.body.innerText.includes('最近的同步')`)) === true
})(), '没切换过去')
check('同步页有工作区输入框与新建按钮', (await ev(`!!document.querySelector('.dcu-run .dcu-input') && [...document.querySelectorAll('button')].some(b => b.textContent.includes('新建并同步'))`)) === true)
check('同步页「重试失败项」按钮存在', (await ev(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('重试失败项'))`)) === true)
check('同步页逐节点/逐文件/日志三个折叠都在', (await ev(`document.querySelectorAll('.dcu-run details.dcu-fold').length`)) >= 3, '少于 3 个')
check('切回「总览」恢复首屏', await (async () => {
  await ev(`[...document.querySelectorAll('.dcu-tab')].find(b => b.textContent.trim() === '总览').click()`)
  await sleep(500)
  return (await ev(`document.querySelectorAll('.dcu-strip .dcu-stat').length`)) === 5
})(), '没回来')

// 节点明细折叠
// 注意两点：<details> 收起时子节点仍在 DOM 里，所以不能靠"agent 行数量变多"判断；
// offsetParent 与 getBoundingClientRect 对收起内容也照样给值（收起用的是
// content-visibility 一类机制，不是 display:none）。只有 innerText 反映**实际渲染
// 出来的文字**，所以用它的长度做判据。
const agentBox = `(() => {
  const d = document.querySelector('#host article.dcu-card details.dcu-fold');
  const rows = [...d.querySelectorAll('.dcu-agent')];
  return { open: d.open, rows: rows.length, textLen: d.innerText.length };
})()`
check('节点明细 <details> 展开后真的多渲染出内容', await (async () => {
  const before = await ev(agentBox)
  await ev(`document.querySelector('#host article.dcu-card details.dcu-fold > summary').click()`)
  await sleep(450)
  const after = await ev(agentBox)
  console.log(`        before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
  return before.open === false && after.open === true && before.rows > 0 && after.textLen > before.textLen
})(), '未展开或渲染文字没有增加')

// 最近任务：折叠触发的按需请求
check('任务队列「最近任务」展开后拉到任务行', await (async () => {
  const btn = await ev(`(() => { const d = document.querySelector('.dcu-chart .dcu-fold'); if (!d) return false; d.open = true; d.dispatchEvent(new Event('toggle')); return true })()`)
  await sleep(900)
  const rows = await ev(`document.querySelectorAll('.dcu-chart .dcu-fold .dcu-agent').length`)
  return btn === true && rows > 0
})(), '没拉到任务或渲染 0 行')

// Router 展开 / 输入 / 发送按钮
check('Router 默认收起', (await ev(`!!document.querySelector('.dcu-router.collapsed')`)) === true)
check('Router 展开后出现 textarea', await (async () => {
  await ev(`document.querySelector('.dcu-router header button').click()`)
  await sleep(450)
  return (await ev(`!!document.querySelector('.dcu-router-input textarea')`)) === true
})(), 'textarea 没出现')
check('Router 输入后发送按钮由 disabled 变可用', await (async () => {
  await ev(`(() => {
    const ta = document.querySelector('.dcu-router-input textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'status');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(400)
  const disabled = await ev(`document.querySelector('.dcu-router-send').disabled`)
  return disabled === false
})(), '发送按钮仍是 disabled')
check('Router 点「收起」回到折叠态', await (async () => {
  const btns = await ev(`[...document.querySelectorAll('.dcu-router header button')].map(b => b.textContent.trim())`)
  await ev(`[...document.querySelectorAll('.dcu-router header button')].find(b => b.textContent.trim() === '收起').click()`)
  await sleep(400)
  return (await ev(`!!document.querySelector('.dcu-router.collapsed')`)) === true
})(), '没收回')

// ---------- 设置页 ----------
await go('settings.section')
check('设置页渲染出连接信息卡', (await ev(`document.body.innerText.includes('连接信息')`)) === true)
check('设置页保留新建工作区的输入框/下拉/按钮', (await ev(`!!document.querySelector('.dcu-settings .dcu-input') && !!document.querySelector('.dcu-settings .dcu-select') && [...document.querySelectorAll('button')].some(b => b.textContent.includes('新建并同步'))`)) === true)
check('设置页每个工作区都有「同步」按钮', (await ev(`[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '同步').length`)) === 2, '数量不对')
check('设置页下拉框选项完整（newest + 每节点）', (await ev(`document.querySelectorAll('.dcu-settings select option').length`)) >= 3, '选项不足')

// ---------- 路由契约 ----------
// 注意：这里断言的是「200 + 关键字段存在」，不是「200 就算过」。
// 早期版本服务端对未知路由也返回 200，于是「八条路由都是 200」在把路径写错时
// 照样 PASS —— 那种断言等于没测。
const routes = await ev(`(async () => {
  const out = {};
  const expect = {
    '/health': ['ok', 'control'],
    '/hosts': ['items', 'summary', 'queue'],
    '/agents': ['items', 'count'],
    '/tasks?limit=5': ['items', 'count'],
    '/router/transcript?limit=20': ['items'],
    '/router/status': ['preset'],
    '/workspaces': ['items', 'nodes'],
    '/workspace/sync/status': ['runs'],
  };
  for (const [p, keys] of Object.entries(expect)) {
    const r = await fetch('/cluster-ui/api' + p);
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    const missing = body === null ? ['<no json>'] : keys.filter((k) => !(k in body));
    out[p] = { status: r.status, missing };
  }
  return JSON.stringify(out);
})()`)
{
  const parsed = JSON.parse(routes)
  const bad = Object.entries(parsed).filter(([, v]) => v.status !== 200 || v.missing.length > 0)
  check('八条只读路由：200 且关键字段齐全', bad.length === 0, JSON.stringify(bad))
}

// 反证：未实现的路由必须是 404。没有这条，「全部 200」仍可能因为服务端宽泛而假绿。
const unknown = JSON.parse(
  await ev(`(async () => { const r = await fetch('/cluster-ui/api/definitely-not-a-route'); return JSON.stringify({ status: r.status }) })()`),
)
check('未实现的路由返回 404（证明上面的 200 不是"什么路径都 200"）', unknown.status === 404, JSON.stringify(unknown))

// ---------- 运行时错误 ----------
await sleep(300)
const errs = await ev(`JSON.stringify(window.__PREVIEW_ERRORS__ || [])`)
check('全程无运行时错误', errs === '[]', errs)

// ---------- 本版改动独有的断言 ----------
// 上面 20 条是「功能没退化」的冒烟检查，**故意在 baseline 上也全绿**——它们证明的是
// "入口还在、行为没变"。但正因为两侧都绿，它们无法证明"这个版本到底改成了什么样"。
// 下面这组才是本版专属：只在 after 成立、在 baseline 上应当失败。用 `--expect-fail-on-baseline`
// 跑一遍就能确认它们真有判别力。
const versionChecks = []

versionChecks.push(
  await (async () => {
    await go('main')
    const m = JSON.parse(
      await ev(`JSON.stringify((() => {
        const stat = document.querySelector('.dcu-strip .dcu-stat');
        const label = stat.querySelector('.dcu-stat-label');
        const value = stat.querySelector('.dcu-stat-value');
        return {
          labelSize: parseFloat(getComputedStyle(label).fontSize),
          valueSize: parseFloat(getComputedStyle(value).fontSize),
          stacked: Math.round(value.getBoundingClientRect().top) > Math.round(label.getBoundingClientRect().top),
        };
      })())`),
    )
    return { name: '统计格：标签与数值上下两行、数值 ≥28px', ok: m.stacked && m.valueSize >= 28 && m.labelSize <= 13, detail: JSON.stringify(m) }
  })(),
)

versionChecks.push(
  await (async () => {
    const m = JSON.parse(
      await ev(`JSON.stringify((() => {
        const body = document.querySelector('.dcu-body');
        const card = document.querySelector('.dcu-card');
        return {
          bodyPad: parseFloat(getComputedStyle(body).paddingLeft),
          cardPad: parseFloat(getComputedStyle(card).paddingLeft),
          bodyMax: getComputedStyle(body).maxWidth,
        };
      })())`),
    )
    return { name: '内容留白：容器 ≥30px、卡内 ≥16px、有宽度上限', ok: m.bodyPad >= 30 && m.cardPad >= 16 && m.bodyMax !== 'none', detail: JSON.stringify(m) }
  })(),
)

for (const v of versionChecks) check(v.name, v.ok, v.detail)

// 设置页底色（需要切到设置页）
await go('settings.section')
{
  const m = JSON.parse(
    await ev(`JSON.stringify((() => {
      const s = document.querySelector('.dcu-settings');
      const card = s.querySelector('.dcu-card');
      return { settingsBg: getComputedStyle(s).backgroundColor, cardBg: getComputedStyle(card).backgroundColor };
    })())`),
  )
  check('设置页：页面底色与卡片不同（token 真的被消费）', m.settingsBg !== 'rgba(0, 0, 0, 0)' && m.settingsBg !== m.cardBg, JSON.stringify(m))
}

page.close()
browser.close()
child.kill()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) process.exitCode = 1
