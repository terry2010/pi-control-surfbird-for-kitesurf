/**
 * src/cdp/types.ts — CDP 协议类型与领域类型。
 *
 * 共享核心约定：只用可擦除 TS 语法（type stripping），不 import @deepseek-ai/*。
 */

/** 有损 JSON 值（CDP 参数/结果的通用载体）。 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

export interface CdpErrorBody {
  code: number
  message: string
  data?: Json
}

export interface CdpRequestMessage {
  id: number
  method: string
  params?: JsonObject
  sessionId?: string
}

export interface CdpResponseMessage {
  id: number
  result?: JsonObject
  error?: CdpErrorBody
}

export interface CdpEventMessage {
  method: string
  params?: JsonObject
  sessionId?: string
}

export type CdpIncoming = CdpResponseMessage | CdpEventMessage

/** 工具层错误码（返回给模型的 {error:{code,...}}）。 */
export type SurfbirdErrorCode =
  | 'browser_reset'
  | 'no_tab'
  | 'not_attached'
  | 'bad_tab_id'
  | 'ref_stale'
  | 'doc_changed'
  | 'no_article'
  | 'timeout'
  | 'cdp_error'
  | 'too_many_sessions'
  | 'element_not_visible'
  | 'not_configured'
  | 'unreachable'
  | 'bad_args'

/** 结构化错误：code + retryable 供工具层直接映射。 */
export class SurfbirdError extends Error {
  readonly code: SurfbirdErrorCode | 'aborted'
  readonly retryable: boolean
  readonly cdpCode?: number

  constructor(code: SurfbirdErrorCode | 'aborted', message: string, opts?: { retryable?: boolean; cdpCode?: number }) {
    super(message)
    this.name = 'SurfbirdError'
    this.code = code
    this.retryable = opts?.retryable ?? false
    this.cdpCode = opts?.cdpCode
  }
}

/** WS 断开/60min 到期：pending 全部以此 reject，SessionBrowser 决定重连。 */
export class BrowserResetError extends Error {
  constructor(message = 'browser connection reset') {
    super(message)
    this.name = 'BrowserResetError'
  }
}

export function isSurfbirdError(e: unknown): e is SurfbirdError {
  return e instanceof SurfbirdError
}

export function isBrowserResetError(e: unknown): e is BrowserResetError {
  return e instanceof BrowserResetError
}

/** Target.getTargets / targetCreated 里的 page target。 */
export interface TabInfo {
  targetId: string
  url: string
  title: string
  /** 'page' | 'browser' | 'iframe' | 'worker' 等；tab 表只保留 page。 */
  type: string
  /** attachToTarget 返回的 sessionId；未 attach 为 undefined。 */
  sessionId?: string
  attachedAt?: number
}

/** snapshot 签发的元素引用。nodeId 与 backendNodeId 同命名空间（引擎实现）。 */
export interface RefEntry {
  /** eN 编号（1 起）。 */
  id: number
  /** 所属 tab 的 targetId——ref 不跨 tab。 */
  tabId: string
  nodeId: number
  /** CSS nth-of-type 兜底路径，nodeId 失效时重查。 */
  selector?: string
  /** 元素 tag（大写）——selector 重解析后校验，防止复活到错误元素。 */
  tag?: string
  /** 签发时的文档代数 token；不匹配 → 先尝试 selector 重解析，失败才 doc_changed。 */
  docToken: string
}

export interface ConsoleEntry {
  seq: number
  ts: number
  /** 'log'|'warning'|'error'|'info'|'debug'|'exception' 等。 */
  type: string
  text: string
  url?: string
  line?: number
}

export interface NetworkRequestInfo {
  requestId: string
  url: string
  method: string
  ts: number
  status?: number
  mimeType?: string
  size?: number
  failed?: boolean
  failureText?: string
}

/** 工具返回的统一信封。 */
export interface ToolEnvelope {
  ok: boolean
  data?: Json
  error?: { code: string; message: string; retryable?: boolean }
}

export function ok(data: Json): ToolEnvelope {
  return { ok: true, data }
}

export function fail(code: string, message: string, retryable = false): ToolEnvelope {
  return { ok: false, error: { code, message, retryable } }
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
