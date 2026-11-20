/**
 * dsh-cluster-ui — 服务端（host）一侧。
 *
 * 职责只有一件：把 cluster 的 UI 网关代理成**同源**的 `/cluster-ui/api/*`。
 *
 *   浏览器 ──同源──> DSH host (/cluster-ui/api/*) ──回环 HTTP + Bearer──> cluster 网关 (127.0.0.1:18150)
 *                                                                              │
 *                                                                              └─mTLS─> 控制面 / Node Agent
 *
 * 为什么不在浏览器里直连网关：
 *   1. 网关的 token 不该下发到浏览器；放在 host 侧，页面拿不到也偷不走。
 *   2. 网关只监听回环，浏览器直连会撞 CORS/混合内容；走同源没有这些问题。
 *
 * 网关本身不碰控制面的 mTLS 证书：证书只在 Python 进程里（cluster/.state/tls）。
 */
import { readFileSync } from 'node:fs'

export const name = 'dsh-cluster-ui'
/** 需要一个 HTTP 监听来挂路由；不注入别的服务，缺了就不激活。 */
export const inject = ['webServer']

const DEFAULTS = {
  /** cluster UI 网关地址（python -m cluster ui 起的那个）。 */
  gatewayUrl: process.env.CLUSTER_UI_GATEWAY_URL || 'http://127.0.0.1:18150',
  /**
   * 网关 token 文件；网关首次启动会自己生成（`<cluster 仓库>/.state/ui/token`）。
   * 默认留空，由环境变量或插件配置指定，避免把某台机器的绝对路径写进仓库。
   *   优先级：config.token > CLUSTER_UI_TOKEN > config.tokenFile > CLUSTER_UI_TOKEN_FILE
   */
  tokenFile: process.env.CLUSTER_UI_TOKEN_FILE || '',
  /** 网关 token 明文（省掉落盘文件；只建议临时调试用）。 */
  token: '',
  /** 单次代理请求的超时；同步/清单这类操作在网关侧是异步的，这里只管 HTTP 往返。 */
  timeoutMs: 20000,
}

/** 只接受本机同源请求：host 头必须是回环，Origin（若有）必须与 host 一致。 */
function sameOrigin(req, port) {
  const host = req.headers.host
  const loopback = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
  if (!host || !loopback.includes(host)) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function send(res, status, value) {
  const payload = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error(`request body exceeds ${limit} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...(config || {}) }
  const base = String(options.gatewayUrl).replace(/\/+$/, '')

  const token = () => {
    if (options.token) return String(options.token).trim()
    const fromEnv = String(process.env.CLUSTER_UI_TOKEN || '').trim()
    if (fromEnv) return fromEnv
    if (!options.tokenFile) {
      throw new Error('未配置 tokenFile（可用插件配置 tokenFile，或环境变量 CLUSTER_UI_TOKEN / CLUSTER_UI_TOKEN_FILE）')
    }
    return readFileSync(options.tokenFile, 'utf8').trim()
  }

  const handler = async (req, res) => {
    const port = ctx.webServer.port
    if (!sameOrigin(req, port)) {
      send(res, 403, { error: 'same-origin loopback request required' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith('/cluster-ui/api/')) {
      send(res, 404, { error: `no route ${req.method} ${url.pathname}` })
      return
    }
    const target = `${base}/api/${url.pathname.slice('/cluster-ui/api/'.length)}${url.search}`
    let body
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        body = await readBody(req)
      } catch (error) {
        send(res, 413, { error: String(error && error.message ? error.message : error) })
        return
      }
    }
    const headers = { accept: 'application/json' }
    if (body) headers['content-type'] = 'application/json'
    // 健康检查在网关侧是免 token 的；带上也不影响。
    try {
      headers.authorization = `Bearer ${token()}`
    } catch (error) {
      send(res, 503, {
        error: `读不到网关 token: ${options.tokenFile || '(未配置)'}（${String(error && error.message ? error.message : error)}）`,
        hint: '先在 cluster 仓库里启动网关：python -m cluster ui --control https://127.0.0.1:18100 --tls-dir .state/tls --cert-name <节点证书名>；再把 tokenFile 指到 .state/ui/token，或设环境变量 CLUSTER_UI_TOKEN_FILE',
      })
      return
    }
    try {
      const response = await fetch(target, {
        method: req.method,
        headers,
        body: body || undefined,
        signal: AbortSignal.timeout(options.timeoutMs),
      })
      const text = await response.text()
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(text)
    } catch (error) {
      const name = error && error.name ? error.name : 'Error'
      send(res, 502, {
        error: name === 'TimeoutError' ? `网关超时（${options.timeoutMs}ms）` : `网关不可达: ${String(error)}`,
        hint: `确认 python -m cluster ui 在 ${base} 上跑着`,
      })
    }
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: '/cluster-ui', handler })
  ctx.effect(() => dispose, 'dsh-cluster-ui: /cluster-ui/api proxy')
  ctx.logger.info('dsh-cluster-ui: /cluster-ui/api -> %s', base)
}
