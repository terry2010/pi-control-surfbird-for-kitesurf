/**
 * src/cdp/transport.ts — 单条 Kitesurf CDP WebSocket 传输层。
 *
 * 职责：endpoint 归一化、ws 连接（Bearer）、id/seq 分发、sessionId 透传事件、
 * pending 超时/abort、close 后整体 reset。只管一条 WS；重连决策在上层。
 */

import WebSocket from 'ws'
import {
  BrowserResetError,
  type CdpEventMessage,
  type CdpIncoming,
  type JsonObject,
  SurfbirdError,
} from './types.ts'

export interface TransportOptions {
  /** 单条 CDP 调用超时（毫秒）。默认 120s。 */
  requestTimeoutMs?: number
}

export interface SendOptions {
  sessionId?: string
  signal?: AbortSignal
  timeoutMs?: number
}

type EventHandler = (event: CdpEventMessage) => void

/** http(s)://host[:port][/path] → ws(s)://host[:port]/devtools/browser；ws(s) 原样。 */
export function normalizeEndpoint(endpoint: string): string {
  const e = endpoint.trim()
  if (e.startsWith('ws://') || e.startsWith('wss://')) return e
  const u = new URL(e.startsWith('http') ? e : `http://${e}`)
  const wsScheme = u.protocol === 'https:' ? 'wss:' : 'ws:'
  const base = `${wsScheme}//${u.host}`
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')
  return `${base}${path}/devtools/browser`
}

export class KitesurfTransport {
  private ws: WebSocket | undefined
  private nextId = 1
  private pending = new Map<
    number,
    {
      resolve: (v: JsonObject) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
      onAbort?: () => void
    }
  >()
  private handlers = new Map<string, Set<EventHandler>>()
  private closeHandlers = new Set<() => void>()
  private closed = false
  private readonly opts: TransportOptions

  constructor(opts: TransportOptions = {}) {
    this.opts = opts
  }

  get isOpen(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN
  }

  /** 建立 WS。失败抛原始错误（ECONNREFUSED 等），由上层映射。 */
  connect(wsUrl: string, token?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {}
      if (token) headers.Authorization = `Bearer ${token}`
      const ws = new WebSocket(wsUrl, { headers })
      this.ws = ws
      this.closed = false

      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }
      const cleanup = () => {
        ws.off('open', onOpen)
        ws.off('error', onError)
      }
      ws.once('open', onOpen)
      ws.once('error', onError)

      ws.on('message', (data) => this.dispatch(data.toString()))
      ws.on('close', () => this.handleClose())
      ws.on('error', () => {
        /* 'close' 随后到达统一处理；这里吞掉避免 unhandled */
      })
    })
  }

  /** 发送 CDP 命令。断线/超时/abort 均 reject。 */
  send<T extends JsonObject = JsonObject>(method: string, params?: JsonObject, opts: SendOptions = {}): Promise<T> {
    if (!this.isOpen || this.ws === undefined) {
      return Promise.reject(new BrowserResetError(`transport closed before ${method}`))
    }
    const id = this.nextId++
    const timeoutMs = opts.timeoutMs ?? this.opts.requestTimeoutMs ?? 120_000
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        detach()
        reject(new SurfbirdError('timeout', `CDP ${method} timed out after ${timeoutMs}ms`, { retryable: true }))
      }, timeoutMs)

      const onAbort = () => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new SurfbirdError('aborted', `CDP ${method} aborted`))
      }
      const detach = () => opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal) {
        if (opts.signal.aborted) {
          clearTimeout(timer)
          reject(new SurfbirdError('aborted', `CDP ${method} aborted`))
          return
        }
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          detach()
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(timer)
          detach()
          reject(e)
        },
        timer,
        onAbort,
      })

      const msg: Record<string, unknown> = { id, method }
      if (params !== undefined) msg.params = params
      if (opts.sessionId !== undefined) msg.sessionId = opts.sessionId
      try {
        this.ws!.send(JSON.stringify(msg))
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        detach()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  /** 订阅 CDP 事件（method 级；sessionId 由 handler 自行过滤）。返回退订函数。 */
  on(method: string, handler: EventHandler): () => void {
    let set = this.handlers.get(method)
    if (!set) {
      set = new Set()
      this.handlers.set(method, set)
    }
    set.add(handler)
    return () => set!.delete(handler)
  }

  /** 订阅 WS close（disconnect/reset 信号）。返回退订函数。 */
  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.ws?.close(1000)
    } catch { /* noop */ }
    this.ws = undefined
    this.failAllPending(new BrowserResetError('transport closed'))
  }

  private dispatch(raw: string): void {
    let msg: CdpIncoming
    try {
      msg = JSON.parse(raw) as CdpIncoming
    } catch {
      return
    }
    if ('id' in msg && msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      const res = msg as { result?: JsonObject; error?: { code: number; message: string } }
      if (res.error) {
        p.reject(new SurfbirdError('cdp_error', res.error.message, { cdpCode: res.error.code }))
      } else {
        p.resolve(res.result ?? {})
      }
      return
    }
    const ev = msg as CdpEventMessage
    if (!ev.method) return
    const set = this.handlers.get(ev.method)
    if (!set) return
    for (const h of set) {
      try {
        h(ev)
      } catch { /* 事件 handler 不外抛 */ }
    }
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    this.ws = undefined
    this.failAllPending(new BrowserResetError('ws closed'))
    for (const h of this.closeHandlers) {
      try {
        h()
      } catch { /* noop */ }
    }
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}
