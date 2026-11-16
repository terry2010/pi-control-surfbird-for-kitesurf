/**
 * src/cdp/events.ts — console / network 观测缓冲。
 *
 * 事件源（design.md §5.8）：
 * - console：Runtime.consoleAPICalled + Runtime.exceptionThrown（不门控，attach 即流）
 * - network：Network.* 门控 per-session enable（attach 时已发）
 * 缓冲按 tab sessionId 分键、环形上限；since 游标做增量读取。
 */

import type { JsonObject } from './types.ts'
import type { KitesurfTransport } from './transport.ts'
import type { ConsoleEntry, NetworkRequestInfo } from './types.ts'

const DEFAULT_CAP = 500

function argText(a: JsonObject | undefined): string {
  if (!a) return ''
  if (typeof a.value === 'string') return a.value
  if (a.value !== undefined && a.value !== null) {
    try {
      return JSON.stringify(a.value)
    } catch {
      return String(a.value)
    }
  }
  if (typeof a.description === 'string') return a.description
  if (typeof a.unserializableValue === 'string') return a.unserializableValue
  return ''
}

export class ConsoleBuffer {
  private entries: ConsoleEntry[] = []
  private seq = 0
  private readonly cap: number
  constructor(cap = DEFAULT_CAP) {
    this.cap = cap
  }

  push(type: string, text: string, extra?: { url?: string; line?: number }): void {
    this.seq += 1
    this.entries.push({ seq: this.seq, ts: Date.now(), type, text, ...extra })
    if (this.entries.length > this.cap) this.entries.splice(0, this.entries.length - this.cap)
  }

  /** since：只返回 seq > since 的条目；only='errors' 过滤 error/exception/assert。 */
  read(opts: { since?: number; only?: string } = {}): { entries: ConsoleEntry[]; nextSince: number; dropped: number } {
    const since = opts.since ?? 0
    const isErr = (t: string) => t === 'error' || t === 'exception' || t === 'assert'
    const list = this.entries.filter((e) => {
      if (e.seq <= since) return false
      if (opts.only === 'errors' && !isErr(e.type)) return false
      return true
    })
    return { entries: list, nextSince: this.seq, dropped: Math.max(0, this.entries.length - this.cap) }
  }

  clear(): void {
    this.entries = []
  }

  get size(): number {
    return this.entries.length
  }
}

interface NetState extends NetworkRequestInfo {
  sessionId: string
  done: boolean
}

export class NetworkBuffer {
  private byId = new Map<string, NetState>()
  private order: string[] = []
  private seq = 0
  private readonly cap: number
  /** 最近一次网络事件时间戳——networkidle 用它做"静默窗口"判定。 */
  lastActivityAt = 0
  constructor(cap = DEFAULT_CAP) {
    this.cap = cap
  }

  private touch(id: string): NetState {
    let s = this.byId.get(id)
    if (!s) {
      s = { requestId: id, url: '', method: '', ts: Date.now(), sessionId: '', done: false }
      this.byId.set(id, s)
      this.order.push(id)
      if (this.order.length > this.cap) {
        const old = this.order.shift()!
        this.byId.delete(old)
      }
    }
    return s
  }

  onRequestWillBeSent(sessionId: string, p: JsonObject | undefined): void {
    const requestId = String(p?.requestId ?? '')
    if (!requestId) return
    this.lastActivityAt = Date.now()
    const req = (p?.request ?? {}) as JsonObject
    const s = this.touch(requestId)
    s.sessionId = sessionId
    s.url = String(req.url ?? s.url)
    s.method = String(req.method ?? s.method)
    s.ts = Date.now()
    s.done = false
    s.failed = undefined
    s.status = undefined
  }

  onResponseReceived(p: JsonObject | undefined): void {
    const requestId = String(p?.requestId ?? '')
    if (!requestId) return
    this.lastActivityAt = Date.now()
    const s = this.byId.get(requestId)
    if (!s) return
    const res = (p?.response ?? {}) as JsonObject
    s.status = typeof res.status === 'number' ? res.status : undefined
    s.mimeType = typeof res.mimeType === 'string' ? res.mimeType : undefined
  }

  onLoadingFinished(p: JsonObject | undefined): void {
    const requestId = String(p?.requestId ?? '')
    this.lastActivityAt = Date.now()
    const s = requestId ? this.byId.get(requestId) : undefined
    if (s) {
      s.done = true
      const len = (p as JsonObject | undefined)?.encodedDataLength
      if (typeof len === 'number') s.size = len
    }
  }

  onLoadingFailed(p: JsonObject | undefined): void {
    const requestId = String(p?.requestId ?? '')
    this.lastActivityAt = Date.now()
    const s = requestId ? this.byId.get(requestId) : undefined
    if (!s) return
    s.done = true
    s.failed = true
    s.failureText = String((p as JsonObject | undefined)?.errorText ?? 'failed')
  }

  /** 读取请求列表（含进行中）。since 按到达序 seq 没有——用 ts 近似？改用 index 游标。 */
  read(opts: { sinceIndex?: number; clear?: boolean } = {}): { entries: NetworkRequestInfo[]; nextIndex: number; total: number } {
    const from = opts.sinceIndex ?? 0
    const ids = this.order.slice(Math.max(0, from))
    const entries = ids.map((id) => {
      const s = this.byId.get(id)!
      const { sessionId: _sid, done: _done, ...pub } = s
      return pub
    })
    const nextIndex = this.order.length
    if (opts.clear) {
      this.byId.clear()
      this.order = []
    }
    return { entries, nextIndex, total: this.order.length }
  }

  /** 进行中的请求数（requestWillBeSent 后未见 finished/failed）。networkidle 判定用。 */
  inFlightCount(): number {
    let n = 0
    for (const id of this.order) {
      const s = this.byId.get(id)
      if (s && !s.done) n++
    }
    return n
  }

  sessionIdOf(requestId: string): string | undefined {
    return this.byId.get(requestId)?.sessionId
  }

  clear(): void {
    this.byId.clear()
    this.order = []
  }
}

/** 把 transport 事件接到 per-sessionId 的 buffer 对。 */
export interface TabBuffers {
  console: ConsoleBuffer
  network: NetworkBuffer
}

export function newTabBuffers(): TabBuffers {
  return { console: new ConsoleBuffer(), network: new NetworkBuffer() }
}

/**
 * 在 transport 上挂全局事件订阅，把事件按 sessionId 路由进 buffers。
 * 返回退订函数。sessionId → buffers 的解析由调用方提供（tab 表可能变化）。
 */
export function wireEventBuffers(
  transport: KitesurfTransport,
  buffersFor: (sessionId: string) => TabBuffers | undefined,
): () => void {
  const unsubs: Array<() => void> = []

  unsubs.push(
    transport.on('Runtime.consoleAPICalled', (ev) => {
      const b = ev.sessionId ? buffersFor(ev.sessionId) : undefined
      if (!b) return
      const p = ev.params ?? {}
      const args = (p.args as JsonObject[] | undefined) ?? []
      const text = args.map(argText).filter(Boolean).join(' ')
      const stack = p.stackTrace as JsonObject | undefined
      const top = (stack?.callFrames as JsonObject[] | undefined)?.[0]
      b.console.push(String(p.type ?? 'log'), text, {
        url: typeof top?.url === 'string' ? top.url : undefined,
        line: typeof top?.lineNumber === 'number' ? top.lineNumber + 1 : undefined,
      })
    }),
  )

  unsubs.push(
    transport.on('Runtime.exceptionThrown', (ev) => {
      const b = ev.sessionId ? buffersFor(ev.sessionId) : undefined
      if (!b) return
      const p = ev.params ?? {}
      const details = (p.exceptionDetails ?? {}) as JsonObject
      const exc = (details.exception ?? {}) as JsonObject
      const text = String(exc.description ?? details.text ?? 'exception')
      b.console.push('exception', text, {
        url: typeof details.url === 'string' ? details.url : undefined,
        line: typeof details.lineNumber === 'number' ? details.lineNumber + 1 : undefined,
      })
    }),
  )

  unsubs.push(
    transport.on('Network.requestWillBeSent', (ev) => {
      const b = ev.sessionId ? buffersFor(ev.sessionId) : undefined
      if (b) b.network.onRequestWillBeSent(ev.sessionId!, ev.params)
    }),
  )
  unsubs.push(
    transport.on('Network.responseReceived', (ev) => {
      const b = ev.sessionId ? buffersFor(ev.sessionId) : undefined
      if (b) b.network.onResponseReceived(ev.params)
    }),
  )
  unsubs.push(
    transport.on('Network.loadingFinished', (ev) => {
      const b = ev.sessionId ? buffersFor(ev.sessionId) : undefined
      if (b) b.network.onLoadingFinished(ev.params)
    }),
  )
  unsubs.push(
    transport.on('Network.loadingFailed', (ev) => {
      const b = ev.sessionId ? buffersFor(ev.sessionId) : undefined
      if (b) b.network.onLoadingFailed(ev.params)
    }),
  )

  return () => {
    for (const u of unsubs) u()
  }
}
