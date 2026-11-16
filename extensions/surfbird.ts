/**
 * extensions/surfbird.ts — pi 扩展入口：surfbird 浏览器控制。
 *
 * 连接目标是任意 Kitesurf CDP 端点：surfbird raw 镜像（:8787）、
 * surfbird auth 镜像（:8080 + Bearer token）、上游 kitesurf。
 * 每个 pi session 独占一条 WS 连接 = 一台独立浏览器；session_shutdown
 * 时断开，引擎侧该 session 的所有 tab 随之销毁。
 *
 * pi 的 extension 实例随会话切换重建（session_switch/reload → shutdown +
 * 重新加载），所以 SessionRegistry 实际只挂当前 session——仍按 sessionId
 * 分键保持与 DSH/OpenCode 相同的隔离语义。
 *
 * 配置：~/.pi/agent/surfbird.json（全局）+ <cwd>/.pi/surfbird.json（受信任
 * 项目）合并 > env > 默认；options 每次 resolved() 重读文件，设置改动
 * 下个工具调用即生效。tokenFile 走机器绑定加密（surfbird-v1:）。
 *
 * src/cdp/ 与 dsh/opencode 两仓共享（host 无关核心），改动需人工同步。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { SessionRegistry } from '../src/cdp/session.ts'
import type { SessionOptions } from '../src/cdp/session.ts'
import { registerSurfbirdTools } from '../src/tools.ts'
import { registerSettingsCommand } from '../src/settings.ts'
import { agentDir, loadOptions } from '../src/config-file.ts'
import { resolveConfig, type ResolvedConfig } from '../src/config.ts'

function envDebug(msg: string): void {
  try {
    const dir = agentDir()
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'surfbird-debug.log'), `${new Date().toISOString()} ${msg}\n`)
  } catch { /* debug log 尽力而为 */ }
}

export default function surfbird(pi: ExtensionAPI): void {
  // 会话作用域在 session_start 捕获（pi 每次会话切换重建本实例）；
  // options 每次调用重读文件——surfbird.json 改动下个工具调用即生效。
  let cwd: string | undefined
  let trusted = false
  pi.on('session_start', async (_event, ctx) => {
    cwd = ctx.cwd
    trusted = ctx.isProjectTrusted()
  })
  const resolved = (): ResolvedConfig => resolveConfig(loadOptions(cwd, trusted))

  const registry = new SessionRegistry({
    get maxSessions() { return resolved().maxSessions },
    get idleEvictMs() { return resolved().idleEvictMs },
  })

  const sessionOpts = (): SessionOptions => {
    const c = resolved()
    return { endpoint: c.endpoint, token: c.token, requestTimeoutMs: c.requestTimeoutMs, keepaliveMs: c.keepaliveMs }
  }

  registerSurfbirdTools(pi, {
    registry,
    sessionOpts,
    get requestTimeoutMs() { return resolved().requestTimeoutMs },
    get outputDir() { return resolved().screenshotDir ?? join(tmpdir(), 'surfbird') },
    configInfo: () => {
      const c = resolved()
      return { configSource: c.configSource, endpoint: c.endpoint, tokenSet: !!c.token, tokenFileError: c.tokenFileError, tokenFileEncrypted: c.tokenFileEncrypted }
    },
    onSessionError: (_key: string, err: unknown) => {
      if (resolved().debugLog) envDebug(`session error: ${err instanceof Error ? err.message : String(err)}`)
    },
  })

  registerSettingsCommand(pi)

  // session 关闭/切换/reload → 断开浏览器（引擎侧 tab 全灭）。
  // pi 同时重建本 extension 实例，registry 在此即弃。
  pi.on('session_shutdown', async () => {
    await registry.disposeAll()
  })
}
