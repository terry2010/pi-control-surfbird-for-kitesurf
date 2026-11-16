/**
 * src/settings.ts — /surfbird-settings 命令：交互式编辑 surfbird.json。
 *
 * pi 没有插件 options 通道，配置落自己的 JSON：
 *   全局  $PI_CODING_AGENT_DIR/surfbird.json（默认 ~/.pi/agent/surfbird.json）
 *   项目  <cwd>/.pi/surfbird.json（仅受信任项目；设置页只写全局文件）
 * 流程：select 字段 → input 新值 → 攒 draft → "Save" 原子写 → 下个工具调用生效
 * （options 每次 resolved() 重读文件，天然热更）。
 * token 明文永不进 surfbird.json——paste/import 经 storeToken 加密落 tokenFile。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { agentDir, fileMtime, globalConfigPath, readOptions, writeOptions } from './config-file.ts'
import { endpointHttpBase, resolveConfig } from './config.ts'
import { storeToken } from './token-store.ts'

type Options = Record<string, unknown>

const DEFAULTS = {
  endpoint: 'http://127.0.0.1:8080',
  requestTimeoutMs: 120000,
  keepaliveMs: 300000,
  maxSessions: 8,
  idleEvictMs: 300000,
} as const

interface Field {
  key: keyof typeof DEFAULTS | 'tokenFile' | 'screenshotDir' | 'debugLog'
  title: string
  desc: string
  kind: 'text' | 'number' | 'toggle'
  min?: number
}

const FIELDS: Field[] = [
  { key: 'endpoint', title: 'Endpoint', desc: 'Kitesurf CDP endpoint: http(s):// base or full ws(s):// URL', kind: 'text' },
  { key: 'tokenFile', title: 'Token file', desc: 'Path to token file (plaintext or surfbird-v1: encrypted). Empty falls back to SURFBIRD_TOKEN env', kind: 'text' },
  { key: 'maxSessions', title: 'Max sessions', desc: 'Concurrent session browsers; excess evicts idle sessions only', kind: 'number', min: 1 },
  { key: 'idleEvictMs', title: 'Idle evict (ms)', desc: 'A session must be idle this long before maxSessions may evict it', kind: 'number', min: 60000 },
  { key: 'requestTimeoutMs', title: 'Request timeout (ms)', desc: 'Per-CDP-call timeout', kind: 'number', min: 1000 },
  { key: 'keepaliveMs', title: 'Keepalive (ms)', desc: 'WS keepalive interval; must stay under the engine 10-min idle limit', kind: 'number', min: 30000 },
  { key: 'screenshotDir', title: 'Screenshot dir', desc: 'Directory for screenshot/PDF output; empty uses $TMPDIR/surfbird', kind: 'text' },
  { key: 'debugLog', title: 'Debug log', desc: `Append diagnostics to ${join(agentDir(), 'surfbird-debug.log')}`, kind: 'toggle' },
]

const ACTION_TEST = 'Test connection'
const ACTION_PASTE = 'Paste token…'
const ACTION_IMPORT = 'Import token file…'
const ACTION_SAVE = 'Save & close'
const ACTION_DISCARD = 'Discard'

function strOpt(options: Options, key: string): string | undefined {
  const v = options[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function numOpt(options: Options, key: keyof typeof DEFAULTS, d: number): number {
  const v = options[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : d
}

/** 字段当前生效值（draft 优先于文件值）。 */
function fieldDisplay(field: Field, file: Options, draft: Options): string {
  const d = draft[field.key as string]
  if (field.kind === 'toggle') {
    const on = typeof d === 'boolean' ? d : file.debugLog === true
    return on ? 'ON' : 'OFF'
  }
  if (d === null) return field.kind === 'number' ? '(default)' : '(empty)'
  if (d !== undefined) return String(d)
  if (field.kind === 'number') return String(numOpt(file, field.key as keyof typeof DEFAULTS, Number(DEFAULTS[field.key as keyof typeof DEFAULTS])))
  if (field.key === 'endpoint') return strOpt(file, 'endpoint') ?? DEFAULTS.endpoint
  return strOpt(file, field.key) ?? '(empty)'
}

/** 探活 /json/version；tokenFile 解密在本地完成，token 只进请求头。 */
async function probe(ctx: ExtensionCommandContext, options: Options): Promise<void> {
  const c = resolveConfig(options)
  const base = endpointHttpBase(c.endpoint)
  if (!base) {
    ctx.ui.notify('endpoint is not a valid URL', 'error')
    return
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const headers: Record<string, string> = {}
    if (c.token) headers.authorization = `Bearer ${c.token}`
    const res = await fetch(`${base}/json/version`, { signal: ctrl.signal, headers })
    if (res.ok) {
      const v = (await res.json()) as Record<string, unknown>
      const product = String(v.Browser ?? v.product ?? 'engine')
      const proto = String(v['Protocol-Version'] ?? v.protocolVersion ?? '')
      ctx.ui.notify(`connected — ${product}${proto ? ` (CDP ${proto})` : ''} · ${c.configSource}`, 'info')
    } else {
      ctx.ui.notify(`unreachable — HTTP ${res.status} · ${c.configSource}`, 'warning')
    }
  } catch (e) {
    ctx.ui.notify(`unreachable — ${e instanceof Error ? e.message : String(e)}`, 'error')
  } finally {
    clearTimeout(timer)
  }
}

/** token 落盘；tokenFile 未配置时把落点写进 draft（同笔保存生效）。 */
async function importToken(ctx: ExtensionCommandContext, file: Options, draft: Options, content: string): Promise<void> {
  const target = strOpt(draft, 'tokenFile') ?? strOpt(file, 'tokenFile') ?? join(agentDir(), 'surfbird-token')
  try {
    const result = storeToken(content, target)
    if (!strOpt(file, 'tokenFile') && !('tokenFile' in draft)) draft.tokenFile = result.path
    ctx.ui.notify(
      result.encrypted ? `Token saved → ${result.path}` : `Token saved UNENCRYPTED (no machine id) → ${result.path}`,
      result.encrypted ? 'info' : 'warning',
    )
  } catch (e) {
    ctx.ui.notify(`Token save failed: ${e instanceof Error ? e.message : String(e)}`, 'error')
  }
}

export function registerSettingsCommand(pi: ExtensionAPI): void {
  pi.registerCommand('surfbird-settings', {
    description: 'Surfbird settings: endpoint, token file, session limits, timeouts',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        // print/json 模式没有 UI——直接打印配置文件路径
        ctx.ui.notify(`Edit ${globalConfigPath()} (options > env > defaults)`, 'info')
        return
      }

      const file = globalConfigPath()
      const startMtime = fileMtime(file)
      const draft: Options = {}

      for (;;) {
        const saved = readOptions(file)
        const pending = Object.keys(draft).length
        const rows = [
          ...FIELDS.map((f) => `${f.title}: ${fieldDisplay(f, saved, draft)}`),
          ACTION_TEST,
          ACTION_PASTE,
          ACTION_IMPORT,
          ACTION_SAVE,
          ACTION_DISCARD,
        ]
        const title = `Surfbird settings — ${file}${pending ? ` (${pending} unsaved)` : ''}`
        const choice = await ctx.ui.select(title, rows)
        if (choice === undefined) {
          if (pending === 0) return
          const keep = await ctx.ui.confirm('Unsaved changes', `Save ${pending} change(s) to ${file}?`)
          if (!keep) return
          break
        }
        if (choice === ACTION_DISCARD) return
        if (choice === ACTION_SAVE) break

        if (choice === ACTION_TEST) {
          await probe(ctx, { ...saved, ...draft })
          continue
        }
        if (choice === ACTION_PASTE) {
          const value = await ctx.ui.input('Paste surfbird token', 'token or surfbird-v1:…')
          if (value?.trim()) await importToken(ctx, saved, draft, value)
          continue
        }
        if (choice === ACTION_IMPORT) {
          const path = await ctx.ui.input('Import token from file', '/path/to/token.txt')
          if (!path?.trim()) continue
          try {
            await importToken(ctx, saved, draft, await readFile(path.trim(), 'utf8'))
          } catch (e) {
            ctx.ui.notify(`Cannot read token file: ${e instanceof Error ? e.message : String(e)}`, 'error')
          }
          continue
        }

        const field = FIELDS[rows.indexOf(choice)]
        if (!field) continue
        if (field.kind === 'toggle') {
          const current = typeof draft.debugLog === 'boolean' ? draft.debugLog : saved.debugLog === true
          draft.debugLog = !current
          continue
        }
        const input = await ctx.ui.input(`${field.title} — ${field.desc}`, fieldDisplay(field, saved, draft))
        if (input === undefined) continue
        const trimmed = input.trim()
        if (field.kind === 'number') {
          if (!trimmed) {
            draft[field.key] = null
            continue
          }
          const n = Number(trimmed)
          if (!Number.isFinite(n) || (field.min !== undefined && n < field.min)) {
            ctx.ui.notify(`Invalid number (min ${field.min})`, 'error')
            continue
          }
          draft[field.key] = n
          continue
        }
        draft[field.key] = trimmed === '' ? null : trimmed
      }

      if (Object.keys(draft).length === 0) return
      try {
        writeOptions(file, draft, startMtime)
        ctx.ui.notify(`Saved → ${file} — applies on next tool call`, 'info')
      } catch (e) {
        ctx.ui.notify(`Save failed: ${e instanceof Error ? e.message : String(e)}`, 'error')
      }
    },
  })
}
