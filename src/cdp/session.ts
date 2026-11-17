/**
 * src/cdp/session.ts — SessionBrowser（per-agent-session 浏览器门面）+ SessionRegistry。
 *
 * SessionBrowser 职责：
 * - 懒连接 KitesurfBrowser（首个工具调用才 connect）
 * - 互斥队列：所有浏览器操作串行（DSH 可并行派发工具）
 * - tab 解析：tabId 缺省=currentTab；未 attach 自动 attach；跨 tab ref 隔离
 * - doc token：navSeq 代数（自身导航动作 + 主 frame frameNavigated 双通道，
 *   宁可过度失效不可漏失效）；refs 存 {nodeId,selector,docToken,tabId}
 * - console/network 环形缓冲按 sessionId 分键（events.ts 接线）
 *
 * SessionRegistry：Map<key, {browser,lastUsed}>；maxSessions 超限只驱逐
 * idle > idleEvictMs 的 session，否则 too_many_sessions。
 */

import { KitesurfBrowser, type BrowserOptions } from './browser.ts'
import { newTabBuffers, wireEventBuffers, type TabBuffers } from './events.ts'
import { WebMcpTracker, type WebMcpTool } from './webmcp.ts'
import {
  BrowserResetError,
  SurfbirdError,
  type Json,
  type JsonObject,
  type RefEntry,
  type TabInfo,
} from './types.ts'

/** evaluate 异常描述只留首行（真实错误信息），丢弃 wasm/JS 引擎栈帧——模型不需要且费 token。 */
function evalErrorText(desc: string): string {
  const first = desc.split('\n', 1)[0] ?? desc
  return first.length > 500 ? `${first.slice(0, 500)}…` : first
}

export interface SessionOptions extends BrowserOptions {
  /** CDP 端点（http(s) base 或 ws(s):// 全 URL）。 */
  endpoint?: string
  /** Bearer token；空=无认证。 */
  token?: string
}

export interface ResolvedTab {
  tab: TabInfo
  sessionId: string
}

export class SessionBrowser {
  readonly key: string
  currentTabId: string | undefined
  lastUsed = Date.now()

  private browser: KitesurfBrowser | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private navSeq = new Map<string, number>()
  private refs = new Map<number, RefEntry>()
  private nextRefId = 1
  private buffers = new Map<string, TabBuffers>()
  private webmcp = new WebMcpTracker()
  private unwire: (() => void) | undefined
  /** 重连后置真：下一次 tab 解析失败报 browser_reset（retryable）而非 bad_tab_id。 */
  private justReset = false

  private readonly optsSource: SessionOptions | (() => SessionOptions)

  constructor(key: string, opts: SessionOptions | (() => SessionOptions) = {}) {
    this.key = key
    this.optsSource = opts
  }

  /** 连接参数惰性解析——传 getter 时（DSH 层接配置）改完端点/密钥，下次重连即生效；
   *  若存快照值，session 会把失效配置一直用到被驱逐。 */
  private opts(): SessionOptions {
    return typeof this.optsSource === 'function' ? this.optsSource() : this.optsSource
  }

  touch(): void {
    this.lastUsed = Date.now()
  }

  get idleMs(): number {
    return Date.now() - this.lastUsed
  }

  /** 互斥队列：同 session 所有操作串行。 */
  enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => op())
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 懒连接。已连接且存活直接返回；断线重连=全新浏览器（旧 tabId 全失效）。 */
  async ensureBrowser(): Promise<KitesurfBrowser> {
    if (this.browser?.isConnected) return this.browser
    const had = this.browser !== undefined
    const opts = this.opts()
    const b = new KitesurfBrowser(opts)
    try {
      await b.connect(opts.endpoint!, opts.token)
    } catch (e) {
      b.disconnect()
      const msg = e instanceof Error ? e.message : String(e)
      // retryable:false——连不上的引擎立即重试没意义；标 true 会让模型空转重试烧 token
      throw new SurfbirdError('unreachable', `cannot reach Kitesurf endpoint ${opts.endpoint}: ${msg}`, { retryable: false })
    }
    this.browser = b
    this.wire(b)
    // 旧 browser 的缓冲随之作废；新 browser 从零开始
    if (had) {
      this.buffers.clear()
      this.refs.clear()
      this.navSeq.clear()
      this.webmcp.reset()
      this.justReset = true
    }
    return b
  }

  private wire(b: KitesurfBrowser): void {
    this.unwire?.()
    this.unwire = wireEventBuffers(b.transport, (sid) => this.buffers.get(sid))
    // 主 frame frameNavigated → navSeq++（doc token 代际；过度失效安全）
    b.transport.on('Page.frameNavigated', (ev) => {
      const frame = (ev.params?.frame ?? {}) as JsonObject
      if (frame.parentId) return // 只看主 frame
      const tab = b.tabBySession(ev.sessionId ?? '')
      if (tab) this.bumpNav(tab.targetId)
    })
    // detach/destroy → 清该 sessionId 的缓冲与 navSeq
    b.transport.on('Target.detachedFromTarget', (ev) => {
      const sid = String(ev.params?.sessionId ?? '')
      if (sid) {
        this.buffers.delete(sid)
        this.webmcp.drop(sid)
      }
    })
    // WebMCP 工具增量事件 → per-sessionId 记账（invoke 需要 frameId）
    b.transport.on('WebMCP.toolsAdded', (ev) => {
      this.webmcp.onToolsAdded(ev.sessionId ?? '', ev.params?.tools)
    })
    b.transport.on('WebMCP.toolsRemoved', (ev) => {
      this.webmcp.onToolsRemoved(ev.sessionId ?? '', ev.params?.tools)
    })
    b.transport.on('Target.targetDestroyed', (ev) => {
      const tid = String(ev.params?.targetId ?? '')
      if (tid) this.navSeq.delete(tid)
    })
  }

  get connected(): boolean {
    return this.browser?.isConnected ?? false
  }

  status(): JsonObject {
    const b = this.browser
    return {
      connected: b?.isConnected ?? false,
      version: b?.version,
      tabs: b?.listTabs().length ?? 0,
      sessionRemainingMs: b ? Math.max(0, b.sessionRemainingMs()) : 0,
      connectedAt: b?.connectedAt ?? null,
    }
  }

  /** tab 解析：tabId 缺省=currentTab（回退第一个 page tab）；未 attach 自动 attach。 */
  async resolveTab(tabId?: string, opts?: { attach?: boolean }): Promise<ResolvedTab> {
    const b = await this.ensureBrowser()
    let targetId = tabId
    if (!targetId) {
      targetId = this.currentTabId ?? b.listTabs()[0]?.targetId
      if (!targetId) throw new SurfbirdError('no_tab', 'no tabs in this browser session')
    }
    const tab = b.tabs.get(targetId)
    if (!tab) {
      if (this.justReset) {
        this.justReset = false
        throw new SurfbirdError('browser_reset', `browser was reset; tabId ${targetId} no longer exists — re-navigate or re-snapshot`, { retryable: true })
      }
      throw new SurfbirdError('bad_tab_id', `unknown tabId: ${targetId}`)
    }
    if (!tab.sessionId && opts?.attach !== false) {
      tab.sessionId = await b.attach(targetId)
      tab.attachedAt = Date.now()
      this.ensureBuffers(tab.sessionId)
    }
    if (!tab.sessionId) throw new SurfbirdError('not_attached', `tab ${targetId} is not attached`)
    this.currentTabId = targetId
    return { tab, sessionId: tab.sessionId }
  }

  /** 指定 tab 的 sessionId（不强制 attach——用于已知已 attach 的场景）。 */
  async sessionOf(tabId?: string): Promise<ResolvedTab> {
    return this.resolveTab(tabId)
  }

  /** 作用域 CDP 调用：解析 tab→sessionId 后 send。tabId/sessionId/noSession 三选一。 */
  async cdp(method: string, params?: JsonObject, opts: { tabId?: string; sessionId?: string; noSession?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<JsonObject> {
    const b = await this.ensureBrowser()
    let sessionId = opts.sessionId
    if (!sessionId && !opts.noSession) {
      const r = await this.resolveTab(opts.tabId)
      sessionId = r.sessionId
    }
    return b.transport.send<JsonObject>(method, params, { sessionId, signal: opts.signal, timeoutMs: opts.timeoutMs })
  }

  /** Runtime.evaluate 简写。 */
  async evaluate(tab: ResolvedTab, expression: string, opts: { awaitPromise?: boolean; returnByValue?: boolean; signal?: AbortSignal } = {}): Promise<Json> {
    const res = await this.cdp('Runtime.evaluate', {
      expression,
      awaitPromise: opts.awaitPromise ?? false,
      returnByValue: opts.returnByValue ?? true,
    }, { sessionId: tab.sessionId, signal: opts.signal })
    const details = res.exceptionDetails as JsonObject | undefined
    if (details) {
      const exc = (details.exception ?? {}) as JsonObject
      const desc = String(exc.description ?? details.text ?? 'evaluation error')
      throw new SurfbirdError('cdp_error', evalErrorText(desc))
    }
    const result = (res.result ?? {}) as JsonObject
    if (result.subtype === 'error') {
      throw new SurfbirdError('cdp_error', evalErrorText(String(result.description ?? 'evaluation error')))
    }
    return (result.value as Json | undefined) ?? null
  }

  // ---------- tab 操作 ----------

  async listTabs(): Promise<TabInfo[]> {
    const b = await this.ensureBrowser()
    await b.refreshTargets()
    return b.listTabs()
  }

  // 注意：以下方法不自带 enqueue——互斥由工具层在 run() 外层统一 enqueue，
  // 方法内部互相调用（resolveTab/cdp/evaluate）若再入队会死锁。

  async newTab(url?: string): Promise<TabInfo> {
    const b = await this.ensureBrowser()
    const tab = await b.createTab(url)
    this.currentTabId = tab.targetId
    this.bumpNav(tab.targetId)
    if (tab.sessionId) this.ensureBuffers(tab.sessionId)
    return tab
  }

  async closeTab(tabId: string): Promise<void> {
    const b = await this.ensureBrowser()
    const tab = b.tabs.get(tabId)
    if (!tab) {
      if (this.justReset) {
        this.justReset = false
        throw new SurfbirdError('browser_reset', `browser was reset; tabId ${tabId} no longer exists`, { retryable: true })
      }
      throw new SurfbirdError('bad_tab_id', `unknown tabId: ${tabId}`)
    }
    await b.closeTab(tabId)
    if (tab.sessionId) this.buffers.delete(tab.sessionId)
    this.navSeq.delete(tabId)
    if (this.currentTabId === tabId) this.currentTabId = undefined
  }

  async selectTab(tabId: string): Promise<TabInfo> {
    const b = await this.ensureBrowser()
    const tab = b.tabs.get(tabId)
    if (!tab) {
      if (this.justReset) {
        this.justReset = false
        throw new SurfbirdError('browser_reset', `browser was reset; tabId ${tabId} no longer exists`, { retryable: true })
      }
      throw new SurfbirdError('bad_tab_id', `unknown tabId: ${tabId}`)
    }
    // attach（含 enables+暖机）；Target.activateTarget 是 no-op 不调用
    if (!tab.sessionId) {
      tab.sessionId = await b.attach(tabId)
      tab.attachedAt = Date.now()
    }
    this.ensureBuffers(tab.sessionId)
    this.currentTabId = tabId
    return tab
  }

  // ---------- 导航（自身动作同步 bumpNav，事件侧再 bump 属过度失效可接受） ----------

  async navigate(url: string, tabId?: string): Promise<JsonObject> {
    const r = await this.resolveTab(tabId)
    this.bumpNav(r.tab.targetId)
    return this.cdp('Page.navigate', { url }, { sessionId: r.sessionId })
  }

  async goHistory(tabId: string | undefined, direction: 'back' | 'forward'): Promise<JsonObject> {
    const r = await this.resolveTab(tabId)
    const hist = await this.cdp('Page.getNavigationHistory', {}, { sessionId: r.sessionId })
    const entries = (hist.entries ?? []) as JsonObject[]
    const current = typeof hist.currentIndex === 'number' ? hist.currentIndex : -1
    const target = direction === 'back' ? current - 1 : current + 1
    if (target < 0 || target >= entries.length) {
      throw new SurfbirdError('cdp_error', `no ${direction} history entry`)
    }
    this.bumpNav(r.tab.targetId)
    return this.cdp('Page.navigateToHistoryEntry', { entryId: entries[target].id }, { sessionId: r.sessionId })
  }

  async reload(tabId?: string, opts: { ignoreCache?: boolean } = {}): Promise<JsonObject> {
    const r = await this.resolveTab(tabId)
    this.bumpNav(r.tab.targetId)
    return this.cdp('Page.reload', { ignoreCache: opts.ignoreCache === true }, { sessionId: r.sessionId })
  }

  /** status/诊断用：当前 browser 快照（未连接返回 undefined）。 */
  browserInfo(): { version?: JsonObject; connectedAt: number; sessionDeadline: number; isConnected: boolean } | undefined {
    const b = this.browser
    if (!b) return undefined
    return { version: b.version, connectedAt: b.connectedAt, sessionDeadline: b.sessionDeadline, isConnected: b.isConnected }
  }

  // ---------- doc token / refs ----------

  bumpNav(targetId: string): void {
    this.navSeq.set(targetId, (this.navSeq.get(targetId) ?? 0) + 1)
  }

  docToken(tab: TabInfo): string {
    return `${tab.targetId}#${this.navSeq.get(tab.targetId) ?? 0}`
  }

  /** 下一个 ref id（snapshot 预算预检用——mint 前估算行宽）。 */
  peekRefId(): number {
    return this.nextRefId
  }

  mintRef(tab: TabInfo, nodeId: number, selector?: string, tag?: string): RefEntry {
    const id = this.nextRefId++
    const ref: RefEntry = { id, tabId: tab.targetId, nodeId, docToken: this.docToken(tab) }
    if (selector) ref.selector = selector
    if (tag) ref.tag = tag
    this.refs.set(id, ref)
    return ref
  }

  /** ref 解析：存在性 + tab 归属 + 文档代际。返回 nodeId。 */
  async resolveRef(refId: number, tab: TabInfo): Promise<number> {
    const ref = this.refs.get(refId)
    if (!ref) throw new SurfbirdError('ref_stale', `unknown ref e${refId} — re-run surfbird_snapshot`)
    if (ref.tabId !== tab.targetId) {
      throw new SurfbirdError('ref_stale', `ref e${refId} belongs to another tab — re-run surfbird_snapshot on this tab`)
    }
    if (ref.docToken !== this.docToken(tab)) {
      // docToken 失配先按 selector 重解析——SPA 同文档导航/pushState 也会 bump navSeq，
      // 过度失效时 selector+tag 还能救回同一元素；救不回才报 doc_changed。
      const revived = await this.tryReviveRef(ref, tab)
      if (revived !== undefined) return revived
      throw new SurfbirdError('doc_changed', `document changed since ref e${refId} was issued — re-run surfbird_snapshot`)
    }
    return ref.nodeId
  }

  /** selector 重查 + tag 校验；成功则原地更新 ref 的 nodeId/docToken。 */
  private async tryReviveRef(ref: RefEntry, tab: TabInfo): Promise<number | undefined> {
    if (!ref.selector || !tab.sessionId) return undefined
    try {
      const doc = await this.cdp('DOM.getDocument', { depth: 0 }, { sessionId: tab.sessionId })
      const rootId = (doc.root as JsonObject | undefined)?.nodeId
      if (typeof rootId !== 'number') return undefined
      const q = await this.cdp('DOM.querySelector', { nodeId: rootId, selector: ref.selector }, { sessionId: tab.sessionId })
      const nodeId = typeof q.nodeId === 'number' ? q.nodeId : 0
      if (!nodeId) return undefined
      if (ref.tag) {
        const d = await this.cdp('DOM.describeNode', { nodeId }, { sessionId: tab.sessionId })
        const name = String(((d.node as JsonObject | undefined)?.nodeName) ?? '')
        if (name.toUpperCase() !== ref.tag) return undefined
      }
      ref.nodeId = nodeId
      ref.docToken = this.docToken(tab)
      return nodeId
    } catch {
      return undefined
    }
  }

  getRef(refId: number): RefEntry | undefined {
    return this.refs.get(refId)
  }

  // ---------- buffers ----------

  private ensureBuffers(sessionId: string): TabBuffers {
    let b = this.buffers.get(sessionId)
    if (!b) {
      b = newTabBuffers()
      this.buffers.set(sessionId, b)
    }
    return b
  }

  buffersFor(sessionId: string): TabBuffers | undefined {
    return this.buffers.get(sessionId)
  }

  // ---------- WebMCP（页面自注册工具） ----------

  /**
   * 确保该 session 已 WebMCP.enable；首次 enable 后等初始 toolsAdded 落定
   * （引擎在 enable 响应后异步发增量事件——静默 250ms 收尾，上限 1500ms；
   * 无工具页面也会等到上限，一次性代价）。
   */
  private async webmcpEnsure(sessionId: string, signal?: AbortSignal): Promise<void> {
    if (this.webmcp.isEnabled(sessionId)) return
    await this.cdp('WebMCP.enable', {}, { sessionId, signal })
    this.webmcp.markEnabled(sessionId)
    const b = this.browser
    if (!b) return
    const start = Date.now()
    let seen = 0
    let lastAt = 0
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearInterval(tick)
        unsub()
        resolve()
      }
      const unsub = b.transport.on('WebMCP.toolsAdded', (ev) => {
        if (ev.sessionId !== sessionId) return
        seen += 1
        lastAt = Date.now()
      })
      const tick = setInterval(() => {
        if (signal?.aborted) return finish()
        const quiet = seen > 0 && Date.now() - lastAt > 250
        if (quiet || Date.now() - start > 1500) finish()
      }, 50)
      if (signal) {
        if (signal.aborted) finish()
        else signal.addEventListener('abort', finish, { once: true })
      }
    })
  }

  /** 当前 tab 页面注册的 WebMCP 工具列表（首次调用自动 enable+等初始事件）。 */
  async webmcpList(r: ResolvedTab, signal?: AbortSignal): Promise<WebMcpTool[]> {
    await this.webmcpEnsure(r.sessionId, signal)
    return this.webmcp.list(r.sessionId)
  }

  /**
   * 调用页面注册的 WebMCP 工具。invokeTool 立即返回 invocationId，结果异步
   * 经 toolResponded 事件——订阅先于发送建立，杜绝竞态。
   */
  async webmcpInvoke(
    r: ResolvedTab,
    toolName: string,
    input: JsonObject | undefined,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    await this.webmcpEnsure(r.sessionId, opts.signal)
    const tool = this.webmcp.get(r.sessionId, toolName)
    if (!tool) {
      const avail = this.webmcp.list(r.sessionId).map((t) => t.name)
      throw new SurfbirdError(
        'cdp_error',
        `unknown WebMCP tool: ${toolName}${avail.length ? ` (available: ${avail.join(', ')})` : ' — page registered no tools'}`,
      )
    }
    const b = this.browser
    if (!b) throw new SurfbirdError('browser_reset', 'browser disconnected')
    const timeoutMs = opts.timeoutMs ?? 60_000
    return await new Promise<JsonObject>((resolve, reject) => {
      let invocationId = ''
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        unsub()
        opts.signal?.removeEventListener('abort', onAbort)
      }
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        cleanup()
        fn()
      }
      const onAbort = () => settle(() => reject(new SurfbirdError('aborted', 'WebMCP invocation aborted')))
      const timer = setTimeout(
        () => settle(() => reject(new SurfbirdError('timeout', `WebMCP tool ${toolName} timed out after ${timeoutMs}ms`, { retryable: true }))),
        timeoutMs,
      )
      // 先订阅再发送：toolResponded 可能紧随 invokeTool 响应到达
      const unsub = b.transport.on('WebMCP.toolResponded', (ev) => {
        if (ev.sessionId !== r.sessionId) return
        const p = (ev.params ?? {}) as JsonObject
        if (!invocationId || p.invocationId !== invocationId) return
        settle(() =>
          resolve({
            invocationId,
            status: String(p.status ?? ''),
            output: p.output ?? null,
            errorText: typeof p.errorText === 'string' ? p.errorText : undefined,
          } as JsonObject),
        )
      })
      if (opts.signal) {
        if (opts.signal.aborted) return onAbort()
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }
      this.cdp('WebMCP.invokeTool', { frameId: tool.frameId, toolName, input: input ?? {} }, { sessionId: r.sessionId, signal: opts.signal })
        .then((res) => {
          invocationId = String(res.invocationId ?? '')
          if (!invocationId) settle(() => reject(new SurfbirdError('cdp_error', 'WebMCP.invokeTool returned no invocationId')))
        })
        .catch((e) => settle(() => reject(e)))
    })
  }

  /** 取消进行中的 WebMCP 调用（invocationId 来自 webmcpInvoke 的超时前手动取消场景）。 */
  async webmcpCancel(r: ResolvedTab, invocationId: string, signal?: AbortSignal): Promise<void> {
    await this.cdp('WebMCP.cancelInvocation', { invocationId }, { sessionId: r.sessionId, signal })
  }

  /** 断开连接并清状态。 */
  async disconnect(): Promise<void> {
    this.unwire?.()
    this.unwire = undefined
    this.browser?.disconnect()
    this.browser = undefined
    this.buffers.clear()
    this.refs.clear()
    this.navSeq.clear()
    this.webmcp.reset()
    this.currentTabId = undefined
  }
}

export interface RegistryConfig {
  maxSessions: number
  idleEvictMs: number
}

export class SessionRegistry {
  private map = new Map<string, SessionBrowser>()
  private readonly cfg: RegistryConfig

  constructor(cfg: RegistryConfig) {
    this.cfg = cfg
  }

  /** 取或建 session（懒连接——构造不触网）。opts 可传 getter：连接参数在每次
   *  （重）连时解析——DSH 层配置热更后，旧 session 重连即吃到新端点。 */
  get(key: string, opts: SessionOptions | (() => SessionOptions) = {}): SessionBrowser {
    const existing = this.map.get(key)
    if (existing) {
      existing.touch()
      return existing
    }
    if (this.map.size >= this.cfg.maxSessions) {
      this.evictIdle()
      if (this.map.size >= this.cfg.maxSessions) {
        throw new SurfbirdError(
          'too_many_sessions',
          `maxSessions=${this.cfg.maxSessions} reached and no idle session to evict — wait or close other agent sessions`,
        )
      }
    }
    const sb = new SessionBrowser(key, opts)
    this.map.set(key, sb)
    return sb
  }

  private evictIdle(): void {
    const now = Date.now()
    for (const [key, sb] of this.map) {
      if (now - sb.lastUsed > this.cfg.idleEvictMs) {
        this.map.delete(key)
        void sb.disconnect()
      }
    }
  }

  async release(key: string): Promise<void> {
    const sb = this.map.get(key)
    if (!sb) return
    this.map.delete(key)
    await sb.disconnect()
  }

  async disposeAll(): Promise<void> {
    const all = [...this.map.values()]
    this.map.clear()
    await Promise.allSettled(all.map((sb) => sb.disconnect()))
  }

  size(): number {
    return this.map.size
  }
}
