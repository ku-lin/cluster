/**
 * 用 CDP 驱动一个一次性 headless Chrome，把 panel 在若干「同场景」下截成 PNG。
 *
 * 为什么要 CDP 而不是 `chrome --screenshot`：对比图里不能只有默认首屏——展开的
 * 明细、工作区同步页、设置页都是这次改动的目标，而 `--screenshot` 没法点。这里
 * 每个场景都有一条确定的操作序列（点哪个 selector、等几帧），改前改后跑同一份。
 *
 * 用法（默认落在 ui-1.2.0；要拍别的版本显式给 --out）：
 *   node scripts/ui-preview/shoot.mjs --which baseline
 *   node scripts/ui-preview/shoot.mjs --which after
 *
 * 每次运行都会在输出目录写一份 `manifest.json`：这份截图到底是**哪份代码、哪份
 * token、哪份 fixture、哪个 Chrome** 拍的，逐张 PNG 带 sha256。复核时不用信日志，
 * 直接重算哈希对一遍即可（`node scripts/ui-preview/compose.mjs --verify-only`）。
 *
 * 视口固定 1440×1000、DPR 1；时钟由页面按 ?now= 冻结（毫秒），滚动条隐藏，两者同源。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
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

/** 证据版本目录。旧版写死 ui-1.1.0，重跑会把上一版的证据覆盖掉。 */
const EVIDENCE = arg('evid', 'docs/evidence/ui-1.2.0')

const which = arg('which', 'after')
const outDir = arg('out', join(repo, EVIDENCE, which === 'baseline' ? 'before' : 'after'))
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

/**
 * 在**页面内部**核对「浏览器真跑的是哪份脚本、注入的样式表长什么样」。
 *
 * 为什么必须这么做：`/identity` 是服务端自述，`x-bundle-sha256` 是响应头自述，
 * 两者都由同一个进程写出，一起错也照样"互相印证"。而这个 harness 早期最大的坑
 * 正是"图看着正常、其实是旧代码"（见 server.mjs 基线钉死的注释）。
 *
 * 这里要在浏览器里算三件服务端**说不了**的事：
 *   1. `document.currentScript` 的真实 URL —— 脚本确实是从 /bundle 加载的；
 *   2. 注入的 `<style>` 是否存在、有多少条规则、哈希是否等于当前 CSS 段；
 *   3. CSS 使用率 —— 选择器在真实 DOM 里一个元素都匹配不上的比例。
 *      这一项是关键：CSS 改动"看起来没生效"的常见真相不是没加载，而是
 *      **选择器指向的 class 根本没人输出**（JSX 用 .dcu-card，CSS 写 .dcu-host-card）。
 *      只看 PNG 哈希变化无法区分这两种情况，必须把使用率量出来写进清单。
 */
const PROBE_PAGE = `(async () => {
  const hex = async (text) => {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const tag = document.getElementById('dsh-cluster-ui-style');
  const css = tag ? tag.textContent : '';
  const root = document.querySelector('.dcu-root, .dcu-settings');
  let dead = 0, total = 0, skipped = 0;
  if (tag && tag.sheet) {
    const walk = (list) => {
      for (const r of Array.from(list)) {
        if (r.selectorText !== undefined) {
          total += 1;
          try { if (document.querySelectorAll(r.selectorText).length === 0 && !/:hover|::|:focus|\\[open\\]/.test(r.selectorText)) dead += 1; }
          catch { skipped += 1 }
        } else if (r.cssRules && r.cssRules.length) walk(r.cssRules);
      }
    };
    walk(tag.sheet.cssRules);
  }
  const cs = root ? getComputedStyle(root) : null;
  return JSON.stringify({
    scriptLoaded: (() => {
      // 直接读真实 <script> 元素：src 与浏览器是否真的把模块交进来（__MOD__）。
      const s = [...document.scripts].filter((el) => el.src && el.src.indexOf('/bundle') >= 0).pop();
      return s ? { src: new URL(s.src).pathname + new URL(s.src).search, deliveredModule: !!window.__MOD__ } : null;
    })(),
    expectedBundleSha: (() => {
      const m = document.querySelector('meta[name="preview-expected-bundle-sha256"]');
      return m ? m.getAttribute('content') : null;
    })(),
    style: css ? { id: tag.id, chars: css.length, sha256: await hex(css), rules: tag.sheet ? tag.sheet.cssRules.length : null } : null,
    styleSha256: css ? await hex(css) : null,
    cssUsage: { totalSelectors: total, deadSelectors: dead, unparsable: skipped },
    root: root ? { cls: root.className, bg: cs.backgroundColor, color: cs.color } : null,
    rendered: !!window.__RENDERED__,
  });
})()`

async function main() {
  mkdirSync(outDir, { recursive: true })

  /**
   * 拍之前先把身份钉住，而不是拍完再补记。
   *
   * `/identity` 由服务端算好（基线的提交号与 sha256、工作区那份的 sha256、token 与
   * fixture 的哈希），这里只负责**核对**：真正发给浏览器的 bundle 哈希（响应头
   * x-bundle-sha256）必须与它自己声称的一致。不一致就说明读到了别的进程/别的文件，
   * 这种截图不能进证据目录。
   */
  const identity = await (async () => {
    let res
    try {
      res = await fetch(`${base}/identity`)
    } catch (error) {
      throw new Error(`取 /identity 失败（预览服务没起？先跑 node scripts/ui-preview/server.mjs）：${error.message}`)
    }
    if (!res.ok) throw new Error(`取 /identity 失败：HTTP ${res.status}`)
    return await res.json()
  })()

  const wantSha = which === 'baseline' ? identity.baseline.clientSha256 : identity.after.clientSha256
  if (which !== 'baseline' && which !== 'after') {
    throw new Error(`--which 必须是 baseline 或 after，收到 ${which}`)
  }
  if (identity.baseline.rev !== '751ea01') {
    throw new Error(`服务声称的基线是 ${identity.baseline.rev}，但本版证据链要求 751ea01 —— 连的是旧服务？`)
  }
  const bundleRes = await fetch(`${base}/bundle?which=${which}`)
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const servedSha = bundleRes.headers.get('x-bundle-sha256')
  const bundleBytes = Buffer.from(await bundleRes.arrayBuffer())
  const bodySha = digest(bundleBytes)
  if (servedSha !== wantSha || bodySha !== wantSha) {
    throw new Error(
      `服务实际发出的 bundle 与 /identity 不符：\n  响应头 ${servedSha}\n  正文   ${bodySha}\n  声称   ${wantSha}\n` +
        '（预览服务可能是用旧代码起的，重启它再拍）',
    )
  }

  /**
   * 从**刚刚那份 bundle 字节**里取出内联 CSS 段，算出它的哈希。
   *
   * 页面里注入的 <style> 必须与这个哈希一致 —— 这才排除了"样式来自某份旧缓存/旧构建"。
   * 取法与 client.js 自身一致：`const CSS = \`` 起，到紧随其后、位于 `function ensureStyle`
   * 之前的那个反引号为止。CSS 本身不含反引号与 `${`（否则模板串早就是语法错误），
   * 所以这里不需要 JS 解析器，纯文本定界即可，且不引入额外依赖。
   */
  const bundleText = bundleBytes.toString('utf8')
  const cssSha256 = (() => {
    const marker = 'const CSS = '
    const cssStart = bundleText.indexOf(marker)
    if (cssStart < 0) return null
    const bodyStart = bundleText.indexOf('`', cssStart) + 1
    const ensureAt = bundleText.indexOf('function ensureStyle', bodyStart)
    if (bodyStart <= 0 || ensureAt < 0) return null
    const cssEnd = bundleText.lastIndexOf('`', ensureAt)
    if (cssEnd <= bodyStart) return null
    // Browser injects the template-literal text into <style>; Windows HTTP/text handling
    // may normalize CRLF -> LF. Compare the normalized bytes the browser consumes.
    const normalized = bundleText.slice(bodyStart, cssEnd).replace(/\r\n/g, '\n')
    return digest(Buffer.from(normalized, 'utf8'))
  })()
  if (!cssSha256) {
    throw new Error('无法从 bundle 里取出内联 CSS 段 —— 定界锚点（const CSS = / function ensureStyle）对不上，证据链失效')
  }

  const chromeVersion = await (async () => {
    try {
      const { execFileSync } = await import('node:child_process')
      return execFileSync(chromePath, ['--version'], { encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  })()

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

    /**
     * 在截图**之前**量一遍浏览器侧事实，并当场对账。
     *
     * 这些值跟 PNG 一起落盘，所以事后能回答"这张图到底是谁画的"：
     *   - 脚本是否真的从 /bundle 加载（scriptLoaded.src / deliveredModule）
     *   - 样式表是否是当前这份 CSS（style.sha256 === cssSha256）
     *   - 样式表是否真的作用到了组件上（root.bg 不等于透明）
     *   - 有没有大片选择器在空转（cssUsage.deadSelectors）
     * 任何一条不符都记进 problems，并在清单里写明，不靠看图猜。
     */
    const probe = await evaluate(page, PROBE_PAGE)
    let evidence = null
    if (probe.error) {
      problems.push(`${scene.id}: 页面内探针失败 ${probe.error}`)
    } else {
      try {
        evidence = JSON.parse(probe.value)
      } catch {
        problems.push(`${scene.id}: 探针返回值不是 JSON`)
      }
    }
    if (evidence) {
      if (!evidence.rendered) problems.push(`${scene.id}: 面板未挂载（__RENDERED__ 未置位）`)
      // 脚本必须真的从 /bundle 加载；页面自报的期望哈希必须等于 /identity 声称的那份。
      if (!evidence.scriptLoaded || !/^\/bundle\?/.test(evidence.scriptLoaded.src || '')) {
        problems.push(`${scene.id}: 页面里没有从 /bundle 加载的脚本（${JSON.stringify(evidence.scriptLoaded)}）`)
      }
      if (evidence.expectedBundleSha !== wantSha) {
        problems.push(
          `${scene.id}: 页面期望的 bundle 哈希与 /identity 不符\n    页面 ${evidence.expectedBundleSha}\n    identity ${wantSha}`,
        )
      }
      // 样式表必须存在；且它的内容必须**逐字节是当前 bundle 里那一段 CSS**。
      // 这才是"样式被注入"的硬证据：不是"有 <style>"，也不是"有 191 条规则"，
      // 而是"这些规则来自刚刚加载的那份脚本，而不是某份旧缓存 / 旧构建"。
      if (!evidence.style) {
        problems.push(`${scene.id}: 没有注入样式表（.dcu-* 的 CSS 一条都没上）`)
      } else if (evidence.styleSha256 !== cssSha256) {
        problems.push(
          `${scene.id}: 页面注入的样式表与当前 bundle 的 CSS 段不一致\n` +
            `    页面 ${evidence.styleSha256}\n    期望 ${cssSha256}`,
        )
      }
      // 样式真的生效：根节点必须有可见底色（token 被消费），而不是透明。
      if (evidence.root && evidence.root.bg === 'rgba(0, 0, 0, 0)') {
        problems.push(`${scene.id}: 根节点背景透明 —— 注入的 CSS 没有作用到组件上`)
      }
    }

    const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const png = Buffer.from(shot.data, 'base64')
    const file = join(outDir, `${scene.id}.png`)
    writeFileSync(file, png)
    shots.push({
      id: scene.id,
      file,
      url,
      theme: scene.theme,
      panel: panel,
      steps: (scene.steps || []).length,
      nodes: painted.value,
      pngSha256: createHash('sha256').update(png).digest('hex'),
      pngBytes: png.length,
      /**
       * 浏览器侧实测（不是服务端自述）。这三块是"图是谁画的"的唯一可信来源：
       *   browser.scriptLoaded   脚本实际从哪个 URL 加载、模块是否交付
       *   browser.style         注入样式表的字符数 / 规则数 / 哈希（== bundle 里那段 CSS）
       *   browser.cssUsage      选择器空转比例（改了样式图不变的常见真因）
       *   browser.root          根节点实际计算样式（证明 token 被消费，不是"有样式但没生效"）
       */
      browser: evidence
        ? {
            scriptLoaded: evidence.scriptLoaded,
            expectedBundleSha: evidence.expectedBundleSha,
            style: evidence.style,
            styleMatchesBundleCss: evidence.styleSha256 === cssSha256,
            cssUsage: evidence.cssUsage,
            root: evidence.root,
            rendered: evidence.rendered,
          }
        : null,
    })
    const pngSha = shots[shots.length - 1].pngSha256
    const usage = evidence ? `${evidence.cssUsage.deadSelectors}/${evidence.cssUsage.totalSelectors} dead sel` : 'no probe'
    console.log(`  ${scene.id}.png  ${png.length}B  sha256:${short(pngSha)}  (${painted.value} nodes, ${usage})`)
  }

  await page.send('Page.navigate', { url: 'about:blank' })
  page.close()
  browser.close()
  child.kill()

  /**
   * 身份清单落盘。它回答一件事：**这张图是哪份代码拍的**。
   *   - baseline 侧 = 钉住的提交（rev + fullSha + client sha256）
   *   - after 侧    = 工作区 client.js 的 sha256（是否 dirty 也记下来）
   *   - 每张 PNG 自带 sha256，改一个像素就对不上
   * 之后再跑 `compose.mjs` 只读这份文件，不再回头问服务，历史截图不会被新服务改标。
   */
  const manifestDoc = {
    schema: 'ui-preview/screenshots/2',
    which,
    evidenceDir: EVIDENCE,
    capturedViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
    frozenClockMs: FROZEN,
    server: {
      base,
      baseline: identity.baseline,
      after: identity.after,
      tokensSha256: identity.tokensSha256,
      fixturesSha256: identity.fixturesSha256,
      identitySchema: identity.schema,
    },
    browser: {
      chromePath,
      chromeVersion,
      flags: 'headless=new, hide-scrollbars, dpr=1, disable-lcd-text, font-render-hinting=none',
    },
    shots,
  }
  const manifestFile = join(outDir, 'manifest.json')
  writeFileSync(manifestFile, `${JSON.stringify(manifestDoc, null, 2)}\n`, 'utf8')

  console.log(`\n${shots.length} shots -> ${outDir}`)
  console.log(`manifest -> ${manifestFile}`)
  console.log(`  baseline ${identity.baseline.rev} (${short(identity.baseline.clientSha256)})  after ${short(identity.after.clientSha256)}`)
  if (problems.length) {
    console.log('\n问题：')
    for (const p of problems) console.log(`  - ${p}`)
    process.exitCode = 1
  } else {
    console.log('场景全部渲染成功，无运行时错误。')
  }
}

const short = (h) => String(h || '').slice(0, 16)

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
