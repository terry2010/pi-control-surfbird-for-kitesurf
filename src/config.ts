/**
 * src/config.ts — 连接配置解析：options（surfbird.json）> env > 默认。
 *
 * pi 没有宿主 options 通道——options 来自我们自己的 JSON 配置：
 * ~/.pi/agent/surfbird.json（全局）+ <cwd>/.pi/surfbird.json（项目，仅
 * 受信任时读）合并后经 config-file.ts 传入。tokenFile 走机器绑定加密。
 */

import { readTokenFile } from './tokenfile.ts'

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:8080'
export const ENDPOINT_ENVS = ['SURFBIRD_URL', 'SURFBIRD_ENDPOINT', 'KITESURF_URL', 'KITESURF_ENDPOINT'] as const
export const TOKEN_ENVS = ['SURFBIRD_TOKEN', 'KITESURF_TOKEN'] as const

export interface ResolvedConfig {
  endpoint: string
  token: string
  tokenFile?: string
  /** tokenFile 读取/解密失败原因（诊断用；此时回退到 token/env 源）。 */
  tokenFileError?: string
  /** tokenFile 内容是 surfbird-v1: 密文。 */
  tokenFileEncrypted?: boolean
  requestTimeoutMs: number
  keepaliveMs: number
  maxSessions: number
  idleEvictMs: number
  screenshotDir?: string
  debugLog: boolean
  /** endpoint/token 的实际来源（status 用）。 */
  configSource: string
}

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

function firstEnv(names: readonly string[]): string | undefined {
  for (const n of names) {
    const v = env(n)
    if (v) return v
  }
  return undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** ws(s)://…/devtools/browser 或 http(s)://base → http(s)://host（探活 /json/version 用）。 */
export function endpointHttpBase(endpoint: string): string | undefined {
  try {
    const u = new URL(endpoint)
    if (u.protocol === 'ws:') u.protocol = 'http:'
    else if (u.protocol === 'wss:') u.protocol = 'https:'
    else if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    u.pathname = ''
    u.search = ''
    u.hash = ''
    return u.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}

function num(v: unknown, d: number, min = 1): number {
  // options 是无 schema 校验的裸 JSON——对齐 DSH schemastery 的 .min() 约束，钳到下限
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : d
}

/** 解析生效配置：options（opencode.json plugin options）> env > 默认。 */
export function resolveConfig(options: Record<string, unknown>): ResolvedConfig {
  const cfgEndpoint = str(options.endpoint)
  const envEndpoint = firstEnv(ENDPOINT_ENVS)
  // options.endpoint 缺省或等于默认值时让 env 优先（与 DSH 版 schemastery 默认值语义一致）
  const endpoint = cfgEndpoint && cfgEndpoint !== DEFAULT_ENDPOINT ? cfgEndpoint : (envEndpoint ?? cfgEndpoint ?? DEFAULT_ENDPOINT)
  const endpointSource = cfgEndpoint && cfgEndpoint !== DEFAULT_ENDPOINT ? 'options' : envEndpoint ? 'env' : 'default'

  const tokenFile = str(options.tokenFile)
  const cfgToken = str(options.token)
  const envToken = firstEnv(TOKEN_ENVS)
  const fileRes = readTokenFile(tokenFile)
  const fileToken = fileRes.token
  const token = fileToken ?? cfgToken ?? envToken ?? ''
  const tokenSource = fileToken ? 'tokenFile' : cfgToken ? 'options' : envToken ? 'env' : 'none'

  return {
    endpoint,
    token,
    tokenFile,
    tokenFileError: fileRes.error,
    tokenFileEncrypted: fileRes.encrypted,
    requestTimeoutMs: num(options.requestTimeoutMs, 120000, 1000),
    keepaliveMs: num(options.keepaliveMs, 300000, 30000),
    maxSessions: num(options.maxSessions, 8, 1),
    idleEvictMs: num(options.idleEvictMs, 300000, 60000),
    screenshotDir: str(options.screenshotDir),
    debugLog: options.debugLog === true,
    configSource: `${endpointSource}+${tokenSource}`,
  }
}
