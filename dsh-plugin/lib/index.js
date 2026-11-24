/**
 * dsh-cluster-ui — 服务端（host）一侧。
 *
 * 两件事：
 *
 * 1. 把 cluster 的 UI 网关代理成**同源**的 `/cluster-ui/api/*`。
 *
 *   浏览器 ──同源──> DSH host (/cluster-ui/api/*) ──回环 HTTP + Bearer──> cluster 网关 (127.0.0.1:18150)
 *                                                                          │
 *                                                                          └─mTLS─> 控制面 / Node Agent
 *
 *   为什么不在浏览器里直连网关：
 *     1. 网关的 token 不该下发到浏览器；放在 host 侧，页面拿不到也偷不走。
 *     2. 网关只监听回环，浏览器直连会撞 CORS/混合内容；走同源没有这些问题。
 *   网关本身不碰控制面的 mTLS 证书：证书只在 Python 进程里（cluster/.state/tls）。
 *
 * 2. Router 板块：能解析成指令的走**确定性快路径**（原样转给网关，不进模型），其余交给一个
 *    真实的 DSH 会话（preset `cluster-router`）——可见、可恢复、有历史。模型只能调四个结构化
 *    工具（cluster_hosts / cluster_status / cluster_dispatch / cluster_sync），拿不到 shell，也没有文件读写。
 *
 *   浏览器 POST /cluster-ui/api/router/message
 *     ├─ 首词命中快路径动词 → 代理给网关 /api/router/message（L2/L4 真实执行，不调模型）
 *     └─ 否则 → 会话里 prompt 一轮 → 收集 tool/call、tool/result、assistant/message
 *               → 写 router.auditFile（审计：输入摘要/工具/参数/结果/耗时/用量）
 *               → 写回网关 /api/router/log（面板轮询的 transcript）
 *               → 把回复 + 工具轨迹返回给面板
 *
 *   会话在首次使用时创建：只传 workspaceId（DSH 不接受同时传 workspaceId 和 cwd），设 preset 并改名
 *   为 cluster-router；sessionId 落盘在 router.stateFile，重载/重启后继续用同一个会话。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

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
  /**
   * Router 板块（真实 LLM 会话）。整段关掉（enabled: false）就退回 1.0.0 的纯规则行为。
   * 落盘路径默认跟着 tokenFile 所在的目录走（`<cluster>/.state/ui`），也可以在插件配置里写死。
   */
  router: {
    enabled: true,
    /** 会话跑的 agent preset；在 profile 的 cordis.patch.yml 里声明，只含 persona/时间/压缩，不含工具。 */
    preset: 'cluster-router',
    /** 会话标题，也是面板会话列表里能看到的会话名。 */
    title: 'cluster-router',
    /** 会话加入的工作区目录；空 = process.cwd()。不存在就按“在 DSH 里打开这个目录”的方式登记。 */
    workspacePath: process.env.CLUSTER_UI_WORKSPACE || '',
    /** sessionId 落盘位置；空 = <tokenFile 的目录>/cluster-router.json。 */
    stateFile: '',
    /** 每次 LLM 决策的审计（JSONL）；空 = <tokenFile 的目录>/router-audit.jsonl。 */
    auditFile: '',
    /** 一轮模型对话最长等待；超时就带着已收到的部分回复返回。 */
    turnTimeoutMs: 180000,
    /** 限流：windowMs 内最多 calls 次模型调用。 */
    rate: { calls: 3, windowMs: 10000 },
    /** 危险操作的两段式确认：第一次请求只登记「待确认」，用户下一条消息确认后才放行。 */
    confirm: { ttlMs: 300000 },
    /** transcript 里单条回复的落盘上限，避免长回复整段塞进网关的 router.json。 */
    replyChars: 4000,
  },
}

/**
 * 快路径动词：与 `cluster/ui_api.py` 的 `_route()` 保持同一份。
 * 只有**第一个词**命中才算——否则「在 kali 上跑 skill:uppercase」会被当成快路径执行
 * （Python 侧还有一条“文本里出现 cap_id 就直接跑”的兜底，那条绝不能被这种句子触发）。
 */
const FAST_VERBS = new Set([
  'help', '帮助', '?', 'status', '状态', '概况', 'hosts', '主机', 'caps', '能力', 'agents',
  'tasks', '任务', 'sync', '同步', 'all', '全部', 'fanout', 'on', '指定', 'run', '执行',
])

/** Router 会话能用的工具名；面板与审计都按这张表判「模型用了什么」。 */
const TOOL_NAMES = ['cluster_hosts', 'cluster_status', 'cluster_dispatch', 'cluster_sync']

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

/**
 * 「用户这条消息算不算一次确认」。
 *
 * 只看用户自己写的字：确认词必须有，否定词一出现就不算。刻意**不**把「强制/覆盖」当确认——
 * 那是意图，不是对后果的确认；真正的确认必须来自**下一次**用户回复，由插件侧的
 * 两段式闸门（见 cluster_sync 工具）强制，而不是只靠提示词。
 */
const CONFIRM_WORDS = /(确认|确定|同意|执行|继续|可以|好的|好|是的|对|没错|照这个|就按这个|ok|yes|go)/i
const DENY_WORDS = /(不要|不用|取消|算了|先不|别|等等|no\b|nope)/i
function isConfirmation(text) {
  const value = String(text || '')
  return CONFIRM_WORDS.test(value) && !DENY_WORDS.test(value)
}

/** 用户消息里出现「同步 / 覆盖 / 强制」这类危险意图：下一句才算确认，本条只是意图。 */
const SYNC_INTENT = /(同步|sync|覆盖|强制|以.{1,12}为准)/i

/** 解析网关 token：config.token > CLUSTER_UI_TOKEN > tokenFile > CLUSTER_UI_TOKEN_FILE。 */function makeTokenReader(options) {
  return () => {
    if (options.token) return String(options.token).trim()
    const fromEnv = String(process.env.CLUSTER_UI_TOKEN || '').trim()
    if (fromEnv) return fromEnv
    if (!options.tokenFile) {
      throw new Error('未配置 tokenFile（可用插件配置 tokenFile，或环境变量 CLUSTER_UI_TOKEN / CLUSTER_UI_TOKEN_FILE）')
    }
    return readFileSync(options.tokenFile, 'utf8').trim()
  }
}

/** 把消息内容块压成纯文本（助手回复、工具结果都用它）。 */
function blocksText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** 模型给的 arguments 是原始 JSON 字符串；解析失败就原样留着，别丢证据。 */
function parseArgs(raw) {
  if (typeof raw !== 'string') return raw ?? {}
  try {
    return JSON.parse(raw)
  } catch {
    return { raw }
  }
}

/** 一步 JSON 序列化，失败退化成 String()，审计与面板都不会因为循环引用炸掉。 */
function json(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function clip(text, limit) {
  const value = typeof text === 'string' ? text : json(text)
  return value.length > limit ? `${value.slice(0, limit)}…(+${value.length - limit} chars)` : value
}

/**
 * 从会话事件里抽出「最终回答 + 工具轨迹 + token 用量」。
 *
 * 只认三类事件：assistant/message（文字与 usage）、tool/call（模型要调什么）、
 * tool/result（调用结果，按 toolCallId 配回去）。超时或取消时最后一个调用可能只落了
 * tool/call，那按 `unknown` 记，不假装成功。
 */
function summarize(events) {
  const tools = []
  const byCall = new Map()
  let answer = ''
  const usage = {}
  for (const event of events) {
    const data = event && event.data ? event.data : {}
    if (event.type === 'assistant/message') {
      const text = blocksText(data.message && data.message.content)
      if (text.trim()) answer = text.trim()
      if (data.usage) {
        for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']) {
          if (typeof data.usage[key] === 'number') usage[key] = (usage[key] || 0) + data.usage[key]
        }
      }
    } else if (event.type === 'tool/call') {
      const row = { name: String(data.name || '?'), args: parseArgs(data.arguments), status: 'pending', at: Number(event.time) || Date.now(), result: '', error: undefined }
      byCall.set(data.callId, row)
      tools.push(row)
    } else if (event.type === 'tool/result') {
      const message = data.message || {}
      const row = byCall.get(message.toolCallId)
      if (!row) continue
      row.status = message.isError ? 'error' : 'ok'
      row.elapsed_ms = (Number(event.time) || Date.now()) - row.at
      const text = blocksText(message.content)
      if (message.isError) row.error = text.slice(0, 400)
      let parsed = text
      try {
        const value = JSON.parse(text)
        if (value && typeof value === 'object') {
          row.node = value.node || (Array.isArray(value.actions) && value.actions[0] ? value.actions[0].node_id : undefined)
          parsed = value.text || text
        }
      } catch {
        /* 不是 JSON 就用原文 */
      }
      row.result = parsed
    }
  }
  for (const row of tools) {
    if (row.status === 'pending') {
      row.status = 'unknown'
      row.elapsed_ms = row.elapsed_ms ?? (Date.now() - row.at)
    }
  }
  return { answer, tools, usage: Object.keys(usage).length ? usage : undefined }
}

/**
 * Router 的会话 + 工具 + 审计。
 *
 * 一个实例只服务一个会话：cluster-router。会话里同一时刻只跑一轮，所以这里用一条
 * promise 链把并发请求排开（面板一次只发一条消息，但网络重试可能重叠）。
 */
class ClusterRouter {
  constructor(ctx, options, token, log) {
    this.ctx = ctx
    this.opts = options
    this.token = token
    this.log = log
    this.agent = undefined
    this.decorated = new WeakSet()
    /** 本实例已经收敛过工具面的 agent（restriction 随插件 fiber 消失，重载后要重做一次）。 */
    this.restricted = new WeakSet()
    this.deniedTools = 0
    this.decorateError = undefined
    this.tools = new Map()
    this.snapshotText = ''
    this.calls = []
    this.queue = Promise.resolve()
    this.busy = false
    /** 待确认的危险操作 {workspace, at}；只有用户下一条消息是明确确认时才会被放行。 */
    this.pending = null
    /** 本轮用户消息是不是一次「确认」（在 turn() 开头算好，工具执行期间只读）。 */
    this.confirming = false
  }

  /** 网关调用：同源代理与工具实现共用同一个入口（token 只在这里出现）。 */
  async gateway(pathname, { method = 'GET', body, timeoutMs } = {}) {
    const headers = { accept: 'application/json', authorization: `Bearer ${this.token()}` }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const path = String(pathname || '').replace(/^\/+/, '')
    const response = await fetch(`${this.opts.gatewayBase}/api/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? this.opts.timeoutMs),
    })
    const text = await response.text()
    let value
    try {
      value = text ? JSON.parse(text) : {}
    } catch {
      value = { raw: text }
    }
    if (!response.ok) {
      const message = value && typeof value === 'object' ? value.error || value.raw || '' : String(value)
      const failure = new Error(`网关 ${method} /api/${path} -> ${response.status}: ${message || text.slice(0, 200)}`)
      failure.status = response.status
      throw failure
    }
    return value
  }

  // ------------------------------------------------------------ 会话
  readState() {
    try {
      return JSON.parse(readFileSync(this.opts.stateFile, 'utf8'))
    } catch {
      return {}
    }
  }

  writeState(patch) {
    const path = this.opts.stateFile
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ ...this.readState(), ...patch, updated_at: new Date().toISOString() }, null, 2), 'utf8')
  }

  /** 会话加入的工作区：先按路径找，找不到就按「在 DSH 里打开这个目录」的方式登记。 */
  async workspaceId() {
    const registry = this.ctx.get('workspaceRegistry')
    if (!registry) throw new Error('DSH 里没有 workspaceRegistry，无法给会话定位工作区')
    const wanted = String(this.opts.workspacePath || process.cwd()).replace(/[\\/]+$/, '').toLowerCase()
    let listed = []
    try {
      listed = [...registry.list()]
    } catch (error) {
      this.log.warn('dsh-cluster-ui: 列不出工作区: %s', String(error && error.message))
    }
    const hit = listed.find((item) => String(item && item.path ? item.path : '').replace(/[\\/]+$/, '').toLowerCase() === wanted)
    if (hit) return hit.id
    const created = await registry.create(wanted, 'cluster')
    return created.id
  }

  /** 首次使用（或会话被删）时创建会话；已存在就解析出 Agent 继续用同一个。 */
  async ensureAgent() {
    if (this.agent) return this.agent
    const controller = this.ctx.get('sessionController')
    if (!controller) throw new Error('DSH 里没有 sessionController，这个宿主不支持 Router 会话')
    const state = this.readState()
    let sessionId = state.sessionId
    let agent

    if (sessionId) {
      const resolved = await controller.resolveAgent(sessionId)
      if (resolved && resolved.agent) agent = resolved.agent
      else if (resolved && resolved.error && resolved.error.code !== 'session/not-found') {
        throw new Error(`会话 ${sessionId} 解析失败: ${resolved.error.code || json(resolved.error)}`)
      }
    }

    if (!agent) {
      // DSH 的 create 只接受 workspaceId 或 cwd 之一；工作区既决定目录，也决定「可见、可恢复」。
      const workspaceId = await this.workspaceId()
      sessionId = sessionId || `session-${randomUUID()}`
      const created = await controller.create({ sessionId, workspaceId, agentPreset: this.opts.preset })
      sessionId = created.sessionId || sessionId
      this.writeState({ sessionId, preset: this.opts.preset, workspace_id: workspaceId })
      const resolved = await controller.resolveAgent(sessionId)
      if (!resolved || !resolved.agent) {
        throw new Error(`新建会话 ${sessionId} 后仍解析不到 Agent: ${json(resolved && resolved.error)}`)
      }
      agent = resolved.agent
      try {
        await controller.rename({ sessionId, title: this.opts.title })
      } catch (error) {
        this.log.warn('dsh-cluster-ui: 会话改名失败（不影响对话）: %s', String(error && error.message))
      }
      // 被换掉的旧会话（state.previousSessionId）：给个能认出来的名字，别在会话列表里冒充当前的 Router。
      if (state.previousSessionId && state.previousSessionId !== sessionId) {
        try {
          await controller.rename({ sessionId: state.previousSessionId, title: `${this.opts.title}（旧）` })
        } catch (error) {
          this.log.warn('dsh-cluster-ui: 旧会话改名失败（忽略）: %s', String(error && error.message))
        }
      }
      this.log.info('dsh-cluster-ui: 建好 Router 会话 %s（preset %s）', sessionId, this.opts.preset)
    }

    this.agent = agent
    this.decorate(agent)
    return agent
  }

  /**
   * 把系统提示、四个工具、工具面收敛挂到一个 Agent 上。
   *
   * 注册只做一次：状态挂在 agent 上（`__dshClusterUiRouter`），工具与提示的闭包都经由这份状态
   * 转给「当前插件实例」。插件热重载后 agent 还活着，只把 `state.owner` 换成新实例——
   * 这样既不会因为重名注册失败（同一个 scope 里工具名唯一），快照/限流/审计也立刻跟着新代码走。
   */
  decorate(agent) {
    if (this.decorated.has(agent)) return
    this.decorated.add(agent)
    let state = agent.__dshClusterUiRouter
    if (!state) {
      state = { owner: this, snapshot: '', installed: false }
      Object.defineProperty(agent, '__dshClusterUiRouter', { value: state, enumerable: false, configurable: true })
    }
    // 上次的注册随插件卸载一起撤掉了（disposer 挂在插件 ctx 上），这里按需重装。
    if (!state.installed) this.install(agent, state)
    state.owner = this
    this.state = state
    this.ensureCwdVariable(agent, state)
    this.ensureRestriction(agent)
  }

  /**
   * 补上 `cwd` 提示变量。
   *
   * profile 的 `system-prompt.personaSuffix` 是 `Your working directory is {{cwd}}.`，而 `cwd`
   * 只有带 persona 工具的 preset 才注册得到；本 preset 刻意没有 persona，于是装配在插值时直接失败：
   *   unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"
   * 我们的提示段是 complete，文字里根本用不到这个值——只要变量存在，插值就能过。
   * 注册一次（state 上记标记），所有权挂在插件 ctx，重载会撤掉后重新补。
   */
  ensureCwdVariable(agent, state) {
    if (state.cwdVariable) return
    try {
      const disposer = agent.ctx.systemPrompt.variable('cwd', () => {
        try {
          return (agent.session && agent.session.header && agent.session.header.cwd) || process.cwd()
        } catch {
          return process.cwd()
        }
      })
      state.cwdVariable = true
      this.ctx.effect(() => () => {
        state.cwdVariable = false
        try {
          disposer()
        } catch {
          /* ignore */
        }
      }, 'dsh-cluster-ui: router cwd prompt variable')
    } catch (error) {
      this.decorateError = `cwd-variable: ${String(error && error.message)}`
      this.log.warn('dsh-cluster-ui: 注册 cwd 提示变量失败: %s', String(error && error.message))
    }
  }

  /** 真注册：提示段 + 四个工具 + 工具面收敛；所有权在插件 ctx 上，插件卸载就撤干净。 */
  install(agent, state) {
    const disposers = []
    const cleanup = () => {
      state.installed = false
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch {
          /* 卸载期的噪音不值得记 */
        }
      }
    }
    try {
      // 这一段就是**整段**系统提示（complete: true）：Router 不需要 harness 身份、文件说明之类。
      disposers.push(agent.ctx.systemPrompt.section({
        name: 'dsh-cluster-ui-router',
        order: 9000,
        interpolate: false,
        complete: true,
        text: () => (state.owner ? state.owner.promptText(state.snapshot) : ''),
      }))
    } catch (error) {
      this.decorateError = `systemPrompt: ${String(error && error.message)}`
      this.log.warn('dsh-cluster-ui: 挂系统提示失败: %s', this.decorateError)
    }
    try {
      this.registerTools(agent, disposers, state)
    } catch (error) {
      this.decorateError = `tools: ${String(error && error.message)}`
      this.log.warn('dsh-cluster-ui: 注册工具失败: %s', this.decorateError)
    }
    // 挂在**插件** ctx 上（不是 agent.ctx）：插件重载/停用时把这些注册撤掉，scope 里不留重名；
    // 下一个实例 decorate 时看到 state.installed=false 会重新装上。
    state.installed = true
    this.ctx.effect(() => cleanup, 'dsh-cluster-ui: router session decoration')
  }

  /**
   * 收敛工具面：只留本插件注册的四个。
   *
   * 每次 decorate 都要重新做一遍——`restrict` 是挂在**调用方 ctx**（也就是插件 fiber）上的，
   * 插件重载时它随 fiber 一起消失；只注册一次会给模型塞回整个宿主的 300+ 个工具
   * （实测一轮 inputTokens 从 ~2k 涨到 ~174k）。同一个实例里用 WeakSet 去重。
   */
  ensureRestriction(agent) {
    if (this.restricted.has(agent)) return
    this.restricted.add(agent)
    try {
      this.restrictTools(agent, [])
    } catch (error) {
      // 收敛失败不算致命：preset 里本来就没有 shell/文件工具，这里只是把宿主全局工具也挡掉。
      this.log.warn('dsh-cluster-ui: 收敛工具面失败（保留 preset 默认）: %s', String(error && error.message))
    }
  }

  /** 四个结构化工具。全部走网关；参数校验工具层先挡一遍，网关侧还会再挡一遍。 */
  registerTools(agent, disposers, state) {
    /**
     * 每个工具单独 try：一个重名不该把另外三个也带下去。
     * `execute` 用 `.call(state.owner, …)` 转给**当前**实例，插件重载后工具立刻跑新代码
     * （工具实现里只用 `this.gateway`，不依赖定义时的那份闭包）。
     */
    const register = (definition) => {
      try {
        disposers.push(agent.ctx.tools.register({
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : json(value) }],
          },
          execute: (args) => definition.execute.call(state.owner || this, args),
        }))
        this.tools.set(definition.name, definition.description)
      } catch (error) {
        this.decorateError = `tools/${definition.name}: ${String(error && error.message)}`
        this.log.warn('dsh-cluster-ui: 注册工具 %s 失败: %s', definition.name, String(error && error.message))
      }
    }

    register({
      name: 'cluster_hosts',
      description: '只读：列出集群节点与真实指标（cpu%、内存%、worker 占用），以及每个节点上挂了多少 agent。用户问「某个节点怎么样 / 负载 / 在不在」时先调它。',
      parameters: {
        type: 'object',
        properties: { node_id: { type: 'string', description: '只看这个节点（可选；不填返回全部）' } },
        additionalProperties: false,
      },
      execute: async function (args) {
        const data = await this.gateway('hosts')
        const rows = (data.items || []).map((row) => {
          const metrics = row.metrics || {}
          return {
            node_id: row.node_id,
            os: row.os,
            role: row.role,
            alive: row.alive,
            cpu_percent: metrics.cpu_percent,
            mem_percent: metrics.mem_percent,
            mem_used_mb: metrics.mem_used_mb,
            mem_total_mb: metrics.mem_total_mb,
            workers: `${metrics.workers}/${metrics.max_workers}`,
            agents: row.agent_count,
          }
        })
        const wanted = args && args.node_id ? String(args.node_id) : ''
        const filtered = wanted ? rows.filter((row) => row.node_id === wanted) : rows
        if (wanted && filtered.length === 0) {
          throw new Error(`没有这个节点: ${wanted}；现有: ${rows.map((row) => row.node_id).join(', ')}`)
        }
        return { count: filtered.length, nodes: filtered }
      },
    })

    register({
      name: 'cluster_status',
      description: '只读：集群状态——最近任务、能力注册表（cap_id 在哪些节点上）、工作区与同步运行状态。下发前用它核对 cap_id / 节点 / 工作区名。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: '返回最近多少个任务（默认 8，最多 20）' } },
        additionalProperties: false,
      },
      execute: async function (args) {
        const limit = Math.max(1, Math.min(20, Number((args && args.limit) || 8)))
        return await this.gateway(`router/status?limit=${limit}`)
      },
    })

    register({
      name: 'cluster_dispatch',
      description: '写：真正把一次能力调用下发给集群。cap_id 必须是能力表里真实存在的；payload 按该能力的 input_schema。给 node 时只在该节点执行（该节点必须持有这个能力）；fanout=true 时每个持有该能力的节点各跑一次。',
      parameters: {
        type: 'object',
        properties: {
          cap_id: { type: 'string', description: '能力 id，例如 skill:uppercase@1.0.0' },
          payload: { type: 'object', description: '传给能力的输入对象，例如 {"text":"hello"}', additionalProperties: true },
          node: { type: 'string', description: '只在这个节点执行（可选）' },
          fanout: { type: 'boolean', description: '每个持有该能力的节点各跑一次（可选，和 node 互斥）' },
        },
        required: ['cap_id'],
        additionalProperties: false,
      },
      execute: async function (args) {
        const capId = String((args && args.cap_id) || '').trim()
        if (!capId) throw new Error('缺 cap_id：先用 cluster_status 看能力表')
        const payload = args && args.payload
        if (payload !== undefined && payload !== null && (typeof payload !== 'object' || Array.isArray(payload))) {
          throw new Error('payload 必须是 JSON 对象')
        }
        const body = { cap_id: capId, payload: payload || {} }
        if (args.node) body.node = String(args.node)
        if (args.fanout === true) body.fanout = true
        return await this.gateway('router/dispatch', { method: 'POST', body, timeoutMs: 60000 })
      },
    })

    register({
      name: 'cluster_sync',
      description: '写（危险）：触发工作区同步，节点之间会互相覆盖文件。只有用户明确确认之后才允许带 confirm:true；没带 confirm:true 网关会直接拒绝——那就把风险说清楚，问用户要不要继续。',
      parameters: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: '工作区名（用 cluster_status 核对）' },
          policy: { type: 'string', description: '冲突策略：newest（默认），或 prefer:<node_id> 指定以某节点为准' },
          confirm: { type: 'boolean', description: '用户已明确确认覆盖；必须传 true，否则拒绝' },
        },
        required: ['workspace'],
        additionalProperties: false,
      },
      execute: async function (args) {
        const workspace = String((args && args.workspace) || '').trim()
        if (!workspace) throw new Error('缺 workspace')
        const now = Date.now()
        if (this.pending && now - this.pending.at > this.opts.confirm.ttlMs) this.pending = null
        if (args.confirm !== true) {
          // 第一次：只登记「待确认」，并明确告诉模型下一步该做什么。
          this.pending = { workspace, at: now }
          throw new Error(`已拒绝（尚未确认）：工作区同步会在节点间互相覆盖文件。现在把这一点告诉用户，请他在下一条消息里明确回复「确认」；在本条回复里不要重试 cluster_sync。policy 可用 newest 或 prefer:<node_id>。`)
        }
        // 第二次：必须是「上一轮问过 + 用户这一轮明确确认 + 工作区对得上」，三者缺一不可。
        // pending.workspace 为 null 表示上一轮只登记了「危险意图」（模型当时没调工具，只是问了用户）。
        const armed = Boolean(this.pending) && this.confirming === true
          && (this.pending.workspace === null || this.pending.workspace === workspace)
        if (!armed) {
          this.pending = { workspace, at: now }
          throw new Error(`已拒绝（未取得用户确认）：即使用户在刚才那条消息里说了「强制」「覆盖」，也必须先问过一轮、再由用户的下一句确认才能执行。请先说明影响并询问用户；不要在同一轮里重试。`)
        }
        this.pending = null
        const body = { workspace, confirm: true }
        if (args.policy) body.policy = String(args.policy)
        return await this.gateway('router/sync', { method: 'POST', body })
      },
    })
  }

  /**
   * 把继承来的工具面收敛到空：只留本插件注册的四个。
   *
   * 为什么不用 allow 白名单：`restrict` 拒绝 allow 列表里出现 scope-local 名（也就是刚注册的这四个），
   * 所以这里反过来算 deny——当前可见但不是我的一律挡掉。preset 里本来就没有 shell/文件工具，
   * 这一层挡的是宿主全局注册的 MCP 工具之类。
   */
  restrictTools(agent, disposers) {
    const mine = new Set(TOOL_NAMES)
    let visible = []
    try {
      // 不传 scope 拿到的是**全局**视图：正好是宿主注册的那些工具（MCP、ego、rea…）。
      visible = agent.ctx.tools.schemas().map((schema) => schema.name)
    } catch (error) {
      this.log.warn('dsh-cluster-ui: 读不到工具的可见集: %s', String(error && error.message))
      return
    }
    const deny = visible.filter((toolName) => !mine.has(toolName) && toolName !== 'run_code')
    if (deny.length === 0) return
    disposers.push(agent.ctx.tools.restrict({ deny }))
    this.deniedTools = deny.length
    this.log.info('dsh-cluster-ui: Router 会话收敛工具面，挡掉 %d 个: %s', deny.length, deny.slice(0, 8).join(', '))
  }

  /** 系统提示：会话身份 + 精简集群快照 + 工具说明 + 安全边界。每轮前刷新快照。 */
  promptText(snapshot) {
    const body = snapshot || this.snapshotText || '（快照暂不可用；先调 cluster_hosts 取实时数据）'
    return [
      '你是 cluster（多机 Agent 集群）的 Router。用户直接跟你说话，你的回复会显示在 cluster 面板的 Router 对话框里。',
      '',
      '当前集群快照（每轮对话开始前从控制面刷新，数字是真实的）：',
      body,
      '',
      '你能用的工具只有这四个。没有 shell、没有文件读写、不能执行任意命令：',
      '- cluster_hosts  只读：节点 + 真实指标（cpu/内存/worker）+ 每个节点的 agent 数',
      '- cluster_status 只读：最近任务、能力注册表（cap_id 在哪些节点）、工作区与同步状态',
      '- cluster_dispatch 写：真正下发一次能力调用；cap_id 必须真实存在，payload 按该能力的 input_schema；node 指定单节点，fanout=true 表示每个持有者都跑',
      '- cluster_sync   写：触发工作区同步（会互相覆盖文件）；必须「先问一轮、用户在下一句明确确认」之后才允许带 confirm:true',
      '',
      '规则：',
      '1. 问节点/负载/活没活 → 先 cluster_hosts，用返回的真实数字回答，不许编。',
      '2. 要在某节点上跑某个能力 → 先核对 cap_id 与节点（不确定就 cluster_status），再 cluster_dispatch。',
      '3. 同步/覆盖/强制一律两段式：第一次只说明影响（哪个工作区、以哪个节点为准、会覆盖谁），并问一句「确认执行吗」；',
      '   **即使用户这条消息里已经写了「强制/覆盖/立刻」，也不算确认**，本条回复里不要带 confirm:true。',
      '   只有用户的下一条消息明确回复「确认/可以/执行」时，你才带 confirm:true 再调 cluster_sync。',
      '4. cluster_sync 被拒绝（未确认）时：照实转述拒绝原因，然后问用户要不要继续；不要在同一轮里重试。',
      '5. 工具报错就照实说并给下一步建议，同一件事不要连续重试超过两次。',
      '6. 中文回答，短，给数字和节点名；不要贴大段 JSON。',
    ].join('\n')
  }

  // ------------------------------------------------------------ 一轮对话
  /** 串行：把并发请求排成一条链，事件不会互相串。 */
  run(text) {
    const next = this.queue.then(() => this.turn(text), () => this.turn(text))
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  pruneCalls(now = Date.now()) {
    this.calls = this.calls.filter((ts) => now - ts < this.opts.rate.windowMs)
    return this.calls.length
  }

  /** 限流：windowMs 内最多 calls 次模型调用。 */
  checkRate(now = Date.now()) {
    const used = this.pruneCalls(now)
    if (used >= this.opts.rate.calls) {
      const waitMs = Math.max(0, this.opts.rate.windowMs - (now - this.calls[0]))
      const failure = new Error(`Router 限流：${Math.round(this.opts.rate.windowMs / 1000)} 秒内最多 ${this.opts.rate.calls} 次模型调用，请 ${Math.ceil(waitMs / 1000)} 秒后再试`)
      failure.status = 429
      throw failure
    }
    this.calls.push(now)
  }

  async turn(text) {
    const started = Date.now()
    const agent = await this.ensureAgent()
    const controller = this.ctx.get('sessionController')

    // 危险操作的两段式闸门，在 prompt 之前定好（工具执行期间只读）：
    //   1) 上一条消息提出了「同步/覆盖/强制」这类意图 → 记一条待确认（还不知道工作区，先占位）；
    //   2) 或上一轮模型调 cluster_sync 没带 confirm → 那时已记了具体工作区；
    //   3) 这一条消息必须是明确的确认，`confirm:true` 才会被放行。
    if (this.pending && Date.now() - this.pending.at > this.opts.confirm.ttlMs) this.pending = null
    if (!this.pending && SYNC_INTENT.test(String(text || '')) && !isConfirmation(text)) {
      this.pending = { workspace: null, at: Date.now() }
    }
    this.confirming = Boolean(this.pending) && isConfirmation(text)

    // 快照先刷进缓存：系统提示的 provider 是同步的，装配时读这里。
    try {
      const snapshot = await this.gateway('router/snapshot')
      this.snapshotText = String(snapshot.text || '')
      // 系统提示的 provider 读的是 agent 上那份 state（跨插件重载稳定），这里同步刷新。
      if (this.state) this.state.snapshot = this.snapshotText
    } catch (error) {
      this.log.warn('dsh-cluster-ui: 取集群快照失败（继续用上一份）: %s', String(error && error.message))
    }

    const events = []
    let resolvedAlready = false
    let settle
    const done = new Promise((resolve) => {
      settle = resolve
    })
    const finish = (reason) => {
      if (resolvedAlready) return
      resolvedAlready = true
      settle(reason)
    }
    let sawTurnStart = false
    let endReason
    const off = this.ctx.on('session/event', (session, event) => {
      if (!session || session.id !== agent.id) return
      if (resolvedAlready) return
      events.push(event)
      if (event.type === 'turn/start') sawTurnStart = true
      else if (event.type === 'turn/end' && sawTurnStart) {
        endReason = event.data && event.data.reason
        finish('turn-end')
      }
    })
    const abort = new AbortController()
    const timer = setTimeout(() => {
      try {
        controller.cancel({ sessionId: agent.id })
      } catch {
        /* 取消失败就只靠超时返回 */
      }
      abort.abort()
      finish('timeout')
    }, this.opts.turnTimeoutMs)

    let reason = 'turn-end'
    this.busy = true
    try {
      await controller.prompt({
        requestId: randomUUID(),
        sessionId: agent.id,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, abort.signal)
      reason = await done
    } finally {
      clearTimeout(timer)
      this.busy = false
      if (typeof off === 'function') off()
    }

    const summary = summarize(events)
    const replyText = summary.answer || (reason === 'timeout'
      ? '（模型这一轮超时了，没有拿到最终回复；已发生的工具调用见下面的动作）'
      : '（模型这一轮没有给出文字回复；看下面的工具调用结果）')
    const elapsed = Date.now() - started
    const model = this.modelOf(agent)

    const actions = summary.tools.map((row) => ({
      kind: 'tool',
      name: row.name,
      node_id: row.node,
      status: row.status,
      args: row.args,
      result: clip(row.result, 600),
      error: row.error,
      elapsed_ms: row.elapsed_ms,
    }))

    const reply = {
      role: 'router',
      text: replyText,
      ts: Date.now() / 1000,
      actions,
      elapsed_ms: elapsed,
      source: 'llm',
      model,
      session_id: agent.id,
      usage: summary.usage,
      reason,
      end_reason: endReason,
      event_types: events.map((event) => event.type),
      tools: summary.tools.map((row) => ({ name: row.name, status: row.status, elapsed_ms: row.elapsed_ms })),
    }

    this.audit({
      kind: 'llm',
      input: { text, chars: text.length },
      session_id: agent.id,
      model,
      tools: summary.tools.map((row) => ({
        name: row.name, args: row.args, status: row.status, elapsed_ms: row.elapsed_ms,
        result: clip(row.result, 600), error: row.error,
      })),
      reply: clip(replyText, 800),
      usage: summary.usage,
      elapsed_ms: elapsed,
      reason,
      end_reason: endReason,
      event_types: events.map((event) => event.type),
    })
    await this.record(text, reply)
    return reply
  }

  /** 会话当前用的模型（只用于面板与审计展示，读不到就不写）。 */
  modelOf(agent) {
    try {
      const header = agent && agent.session ? agent.session.header : undefined
      const selection = header && header.model ? header.model : undefined
      if (selection && selection.provider) return `${selection.provider}/${selection.model}`
    } catch {
      /* 读不到就算了 */
    }
    return undefined
  }

  /** 把这一轮写回网关的 transcript，面板轮询就能看到（失败不影响回复本身）。 */
  async record(text, reply) {
    try {
      await this.gateway('router/log', {
        method: 'POST',
        body: {
          items: [
            { role: 'user', text, ts: reply.ts - reply.elapsed_ms / 1000, source: 'llm' },
            {
              role: 'router',
              text: clip(reply.text, this.opts.replyChars),
              ts: reply.ts,
              actions: reply.actions,
              elapsed_ms: reply.elapsed_ms,
              source: 'llm',
              model: reply.model,
              usage: reply.usage,
            },
          ],
        },
      })
    } catch (error) {
      this.log.warn('dsh-cluster-ui: 写 transcript 失败（回复仍会返回面板）: %s', String(error && error.message))
    }
  }

  /** 审计：每次决策一行 JSONL。快路径也记（kind=fast，没有 model/usage），方便核对「这条没进模型」。 */
  audit(entry) {
    const path = this.opts.auditFile
    const row = { ts: new Date().toISOString(), ...entry }
    try {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${json(row)}\n`, 'utf8')
    } catch (error) {
      this.log.warn('dsh-cluster-ui: 写审计失败: %s', String(error && error.message))
    }
  }

  diag() {
    const state = this.readState()
    const adopted = this.agent ? Boolean(this.agent.__dshClusterUiRouter) : false
    let raw
    try {
      raw = readFileSync(this.opts.stateFile, 'utf8').slice(0, 240)
    } catch (error) {
      raw = `READ FAILED: ${String(error && error.message)}`
    }
    return {
      enabled: this.opts.enabled,
      preset: this.opts.preset,
      session_id: state.sessionId || null,
      session_file_raw: raw,
      state_file: this.opts.stateFile,
      audit_file: this.opts.auditFile,
      workspace_path: this.opts.workspacePath || process.cwd(),
      decorated: this.agent ? this.decorated.has(this.agent) : false,
      decorate_error: this.decorateError || null,
      // 工具是「装一次、之后跨重载沿用」的：用 agent 上的状态判断是否在挂，而不是本实例的注册表。
      tools: adopted ? TOOL_NAMES : [],
      restricted: this.agent ? this.restricted.has(this.agent) : false,
      denied_tools: this.deniedTools,
      snapshot: this.snapshotText,
      rate: { ...this.opts.rate, used: this.pruneCalls() },
      busy: this.busy,
    }
  }
}

export function apply(ctx, config = {}) {
  const raw = config || {}
  const options = { ...DEFAULTS, ...raw }
  const routerInput = raw.router || {}
  // 落盘路径默认跟着 tokenFile 的目录走（<cluster>/.state/ui），仓库里不写死绝对路径。
  const stateDir = routerInput.stateDir
    ? String(routerInput.stateDir)
    : options.tokenFile
      ? dirname(options.tokenFile)
      : join(process.cwd(), '.state', 'ui')
  const routerOpts = {
    ...DEFAULTS.router,
    ...routerInput,
    rate: { ...DEFAULTS.router.rate, ...(routerInput.rate || {}) },
    stateFile: routerInput.stateFile ? String(routerInput.stateFile) : join(stateDir, 'cluster-router.json'),
    auditFile: routerInput.auditFile ? String(routerInput.auditFile) : join(stateDir, 'router-audit.jsonl'),
    gatewayBase: String(options.gatewayUrl).replace(/\/+$/, ''),
    timeoutMs: options.timeoutMs,
  }

  const base = routerOpts.gatewayBase
  const token = makeTokenReader(options)
  const router = new ClusterRouter(ctx, routerOpts, token, ctx.logger)

  /** 代理到网关：除了 Router 的两条插件路由，其余 /api/* 全部透明转发。 */
  const proxy = async (req, res, url) => {
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

  /** Router 消息：先判快路径，命中就让网关按规则执行并落 transcript（不进模型）。 */
  const handleMessage = async (req, res) => {
    let text = ''
    try {
      const raw = await readBody(req)
      let body = {}
      if (raw) {
        try {
          body = JSON.parse(raw)
        } catch {
          send(res, 400, { error: 'body 不是 JSON' })
          return
        }
      }
      text = String((body && body.text) || '').trim()
    } catch (error) {
      send(res, 413, { error: String(error && error.message ? error.message : error) })
      return
    }
    if (!text) {
      send(res, 400, { error: '消息不能为空' })
      return
    }
    const first = text.split(/\s+/)[0].toLowerCase()
    if (!routerOpts.enabled) {
      // Router 整段关掉：退回只走网关规则的老行为。
      await proxy(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'))
      return
    }
    if (FAST_VERBS.has(first)) {
      // 快路径审计：明确写成 kind=fast 且不带 model/usage ——「没进模型」可以直接核对。
      const started = Date.now()
      try {
        const answer = await router.gateway('router/message', { method: 'POST', body: { text } })
        router.audit({
          kind: 'fast',
          input: { text, chars: text.length },
          handled_by: 'gateway-rule',
          verb: first,
          reply: clip(answer && answer.text, 400),
          actions: (answer && answer.actions) || [],
          elapsed_ms: Date.now() - started,
        })
        send(res, 200, answer)
      } catch (error) {
        send(res, error.status || 502, { error: String(error && error.message ? error.message : error) })
      }
      return
    }
    try {
      router.checkRate()
      const answer = await router.run(text)
      send(res, 200, answer)
    } catch (error) {
      const status = error && error.status ? error.status : 500
      send(res, status, { error: String(error && error.message ? error.message : error) })
    }
  }

  /** 诊断：会话 id、可见工具、快照、限流用量。用来核对「模型到底能不能看到别的工具」。 */
  const handleDiag = async (res) => {
    try {
      const agent = await router.ensureAgent()
      let visible = []
      try {
        visible = agent.ctx.tools.schemas().map((schema) => schema.name)
      } catch (error) {
        visible = [`<读不到: ${String(error && error.message)}>`]
      }
      send(res, 200, { ...router.diag(), session_id: agent.id, visible_tools: visible })
    } catch (error) {
      send(res, 500, { error: String(error && error.message ? error.message : error), diag: router.diag() })
    }
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
    if (url.pathname === '/cluster-ui/api/router/message' && req.method === 'POST') {
      await handleMessage(req, res)
      return
    }
    if (url.pathname === '/cluster-ui/api/router/diag' && req.method === 'GET') {
      await handleDiag(res)
      return
    }
    await proxy(req, res, url)
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: '/cluster-ui', handler })
  ctx.effect(() => dispose, 'dsh-cluster-ui: /cluster-ui/api proxy')
  ctx.logger.info('dsh-cluster-ui: /cluster-ui/api -> %s（Router 会话 preset=%s，模型路径 %s）',
    base, routerOpts.preset, routerOpts.enabled ? '开' : '关')
}
