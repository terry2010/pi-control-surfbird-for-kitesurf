/**
 * src/cdp/browser.ts — KitesurfBrowser：一条 WS = 一台浏览器（per-connection BrowserState）。
 *
 * 职责：connect/握手/getTargets 同步、tab 生命周期（create/attach/close/list）、
 * attach 后 enables + DOM.getDocument 暖机、target 事件驱动的 tab 表清理、
 * keepalive（<10min idle 上限）、60min 会话预算记录、disconnect。
 *
 * 引擎怪癖（design.md §8/§9，勿违反）：
 * - Target.createTarget 不导航（url 只进 history）→ url 必须紧跟 Page.navigate
 * - attach 后 pageScript 可能为 null → Input 系/截图静默 no-op，须 DOM.getDocument 暖机
 * - sessionId 匹配不到 target 时静默落到第一个 page target → tab 表必须事件驱动清理
 * - Target.activateTarget 是 no-op → select 只做 attach+置 current
 */

import {
  BrowserResetError,
  SurfbirdError,
  type JsonObject,
  type TabInfo,
} from './types.ts'
import { KitesurfTransport, normalizeEndpoint, type TransportOptions } from './transport.ts'

export interface BrowserOptions extends TransportOptions {
  /** WS 心跳间隔；默认 5min（引擎 idle 上限 10min，必须小于它）。0=关闭。 */
  keepaliveMs?: number
  /** 单 WS 绝对上限；默认 60min（引擎 MAX_SESSION_MS）。仅用于 status 展示。 */
  maxSessionMs?: number
}

/** attach 后统一下发的 enables（引擎分域门控，照发覆盖真有门控的域）。 */
const ATTACH_ENABLES = ['Page.enable', 'Runtime.enable', 'DOM.enable', 'Network.enable', 'Accessibility.enable'] as const

export class KitesurfBrowser {
  readonly transport: KitesurfTransport
  /** targetId → TabInfo（仅 type==='page'）。事件驱动维护。 */
  readonly tabs = new Map<string, TabInfo>()
  version: JsonObject | undefined
  connectedAt = 0
  /** connect 时间戳 + maxSessionMs → 会话预算（status 展示用）。 */
  sessionDeadline = 0
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined
  private disposed = false
  private readonly opts: BrowserOptions

  constructor(opts: BrowserOptions = {}) {
    this.opts = opts
    this.transport = new KitesurfTransport({ requestTimeoutMs: opts.requestTimeoutMs })
  }

  get isConnected(): boolean {
    return this.transport.isOpen && !this.disposed
  }

  async connect(endpoint: string, token?: string): Promise<void> {
    const wsUrl = normalizeEndpoint(endpoint)
    await this.transport.connect(wsUrl, token)
    this.connectedAt = Date.now()
    this.sessionDeadline = this.connectedAt + (this.opts.maxSessionMs ?? 3_600_000)

    const unsubClose = this.transport.onClose(() => this.stopKeepalive())
    void unsubClose // close 时 keepalive 随 timer 生命周期结束；unsub 不需要持有

    // target 生命周期事件 → tab 表即时清理（防 sessionId fallback 错 tab）
    this.transport.on('Target.targetCreated', (ev) => this.onTargetCreated(ev.params))
    this.transport.on('Target.targetDestroyed', (ev) => this.onTargetDestroyed(ev.params))
    this.transport.on('Target.targetInfoChanged', (ev) => this.onTargetInfoChanged(ev.params))
    this.transport.on('Target.attachedToTarget', (ev) => this.onAttached(ev.params))
    this.transport.on('Target.detachedFromTarget', (ev) => this.onDetached(ev.params))

    const ver = await this.transport.send<JsonObject>('Browser.getVersion')
    this.version = ver
    const targets = await this.transport.send<JsonObject>('Target.getTargets')
    this.syncTargets(targets)
    this.startKeepalive()
  }

  /** 断开并释放。幂等。 */
  disconnect(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopKeepalive()
    this.transport.close()
    this.tabs.clear()
  }

  /** Target.getTargets → 重建 page tab 表（保留已知 sessionId）。 */
  private syncTargets(result: JsonObject | undefined): void {
    const list = (result?.targetInfos ?? []) as JsonObject[]
    const seen = new Set<string>()
    for (const t of list) {
      const type = String(t.type ?? '')
      if (type !== 'page') continue
      const targetId = String(t.targetId ?? '')
      if (!targetId) continue
      seen.add(targetId)
      const prev = this.tabs.get(targetId)
      this.tabs.set(targetId, {
        targetId,
        url: String(t.url ?? ''),
        title: String(t.title ?? ''),
        type,
        sessionId: prev?.sessionId,
        attachedAt: prev?.attachedAt,
      })
    }
    // 引擎已不在的 target 直接清（含我们 attach 过但已消失的）
    for (const id of [...this.tabs.keys()]) {
      if (!seen.has(id)) this.tabs.delete(id)
    }
  }

  private onTargetCreated(params: JsonObject | undefined): void {
    const t = params?.targetInfo as JsonObject | undefined
    if (!t || String(t.type) !== 'page') return
    const targetId = String(t.targetId ?? '')
    if (!targetId) return
    this.tabs.set(targetId, {
      targetId,
      url: String(t.url ?? ''),
      title: String(t.title ?? ''),
      type: 'page',
    })
  }

  private onTargetDestroyed(params: JsonObject | undefined): void {
    const targetId = String(params?.targetId ?? '')
    if (targetId) this.tabs.delete(targetId)
  }

  private onTargetInfoChanged(params: JsonObject | undefined): void {
    const t = params?.targetInfo as JsonObject | undefined
    if (!t) return
    const targetId = String(t.targetId ?? '')
    const tab = this.tabs.get(targetId)
    if (!tab) return
    tab.url = String(t.url ?? tab.url)
    tab.title = String(t.title ?? tab.title)
  }

  private onAttached(params: JsonObject | undefined): void {
    const targetInfo = params?.targetInfo as JsonObject | undefined
    const sessionId = String(params?.sessionId ?? '')
    const targetId = String(targetInfo?.targetId ?? '')
    const tab = this.tabs.get(targetId)
    if (tab && sessionId) {
      tab.sessionId = sessionId
      tab.attachedAt = Date.now()
    }
  }

  private onDetached(params: JsonObject | undefined): void {
    const sessionId = String(params?.sessionId ?? '')
    if (!sessionId) return
    for (const tab of this.tabs.values()) {
      if (tab.sessionId === sessionId) {
        tab.sessionId = undefined
        tab.attachedAt = undefined
      }
    }
  }

  /** sessionId → TabInfo 反查（input 事件路由等场景）。 */
  tabBySession(sessionId: string): TabInfo | undefined {
    for (const tab of this.tabs.values()) {
      if (tab.sessionId === sessionId) return tab
    }
    return undefined
  }

  /** attachToTarget + enables + 暖机。已 attach 直接返回现有 sessionId。 */
  async attach(targetId: string): Promise<string> {
    const tab = this.tabs.get(targetId)
    if (!tab) throw new SurfbirdError('bad_tab_id', `unknown tabId: ${targetId}`)
    if (tab.sessionId) return tab.sessionId
    const res = await this.transport.send<JsonObject>('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    const sessionId = String(res.sessionId ?? '')
    if (!sessionId) throw new SurfbirdError('not_attached', `attachToTarget returned no sessionId for ${targetId}`)
    tab.sessionId = sessionId
    tab.attachedAt = Date.now()
    // enables 逐个容错：某域不支持不影响其他
    for (const method of ATTACH_ENABLES) {
      try {
        await this.transport.send(method, {}, { sessionId })
      } catch { /* enable 失败不阻断 attach */ }
    }
    await this.warm(sessionId)
    return sessionId
  }

  /** DOM.getDocument 暖机：拉起 pageScript + 注册 domEnabledSessions。 */
  async warm(sessionId: string): Promise<void> {
    try {
      await this.transport.send('DOM.getDocument', { depth: 1 }, { sessionId })
    } catch { /* 暖机失败不阻断——后续命令会再拉起 */ }
  }

  /** 创建 tab：createTarget(about:blank) → attach → enables → 暖机 → 可选 navigate。 */
  async createTab(url?: string): Promise<TabInfo> {
    const res = await this.transport.send<JsonObject>('Target.createTarget', { url: 'about:blank' })
    const targetId = String(res.targetId ?? '')
    if (!targetId) throw new SurfbirdError('cdp_error', 'Target.createTarget returned no targetId')
    // targetCreated 事件异步到达；这里直接补登记防 select 立即用
    if (!this.tabs.has(targetId)) {
      this.tabs.set(targetId, { targetId, url: 'about:blank', title: '', type: 'page' })
    }
    const sessionId = await this.attach(targetId)
    if (url) {
      await this.navigate(sessionId, url)
    }
    return this.tabs.get(targetId)!
  }

  async navigate(sessionId: string, url: string): Promise<JsonObject> {
    return this.transport.send<JsonObject>('Page.navigate', { url }, { sessionId })
  }

  async closeTab(targetId: string): Promise<void> {
    await this.transport.send('Target.closeTarget', { targetId })
    // targetDestroyed 事件异步清表；这里同步删防立刻复用
    this.tabs.delete(targetId)
  }

  listTabs(): TabInfo[] {
    return [...this.tabs.values()]
  }

  /** 主动刷新 tab 表（url/title 可能滞后于 targetInfoChanged）。 */
  async refreshTargets(): Promise<void> {
    if (!this.isConnected) return
    try {
      const targets = await this.transport.send<JsonObject>('Target.getTargets')
      this.syncTargets(targets)
    } catch { /* 刷新失败不阻断读路径 */ }
  }

  requireTab(targetId: string): TabInfo {
    const tab = this.tabs.get(targetId)
    if (!tab) throw new SurfbirdError('bad_tab_id', `unknown tabId: ${targetId}`)
    if (!tab.sessionId) throw new SurfbirdError('not_attached', `tab ${targetId} is not attached`)
    return tab
  }

  /** 会话剩余预算（ms）；<=0 表示已到 60min 硬上限边缘。 */
  sessionRemainingMs(): number {
    return this.sessionDeadline - Date.now()
  }

  private startKeepalive(): void {
    const ms = this.opts.keepaliveMs ?? 300_000
    if (ms <= 0) return
    this.keepaliveTimer = setInterval(() => {
      if (!this.isConnected) return
      this.transport.send('Browser.getVersion').catch(() => { /* close 事件统一处理 */ })
    }, ms)
    this.keepaliveTimer.unref?.()
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = undefined
    }
  }
}

export { BrowserResetError }
