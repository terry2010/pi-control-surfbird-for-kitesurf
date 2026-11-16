/**
 * src/tools.ts — 28 个 surfbird_* 工具的 pi 薄壳。
 *
 * 约定（与 DSH/OpenCode 版对齐）：
 * - execute 返回 {content:[...], details}；文本型工具返回 {ok:true,text,...meta}
 *   信封，toResult 把 .text 直出为 text part（模型可读性优先于 JSON 转义）
 * - 成功 {ok:true, ...payload}；失败 {ok:false,error:{code,message,retryable}}
 * - 每个工具的 run 经 sess.enqueue 串行化；同 session 调用严格按提交序执行，
 *   跨 session 各自独立浏览器连接
 * - ctx.sessionManager.getSessionId() 为 session key（pi session id 即隔离边界；
 *   pi 每次会话切换重建 extension 实例，registry 实际仍是单 session）
 * - signal 透传到 CDP/等待（用户停止调用时中止）
 * - 截图/PDF 落盘 outputDir/tmp；截图内联为 image content part 直给模型，
 *   超 8MiB 只回路径；PDF 只回路径
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentToolResult, ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { SessionRegistry, type SessionBrowser } from './cdp/session.ts'
import { SurfbirdError, isBrowserResetError, type JsonObject } from './cdp/types.ts'
import { snapshot } from './cdp/snapshot.ts'
import { axTree } from './cdp/ax.ts'
import { waitFor, type WaitState } from './cdp/wait.ts'
import * as input from './cdp/input.ts'
import { extract } from './cdp/extract.ts'
import { buildFindExpression } from './find.ts'
import { buildLinksExpression } from './links.ts'
import type { PropertySpec, SpecMap } from './schema.ts'
import { specToTypeBox } from './spec-typebox.ts'

// 本地 JsonValue 别名：宿主无关，值只做 typeof 判定与 JSON 序列化
type JsonValue = any

type ExecCtx = { signal?: AbortSignal; sessionID: string }

const S = (description: string): PropertySpec => ({ type: 'string', description })
const SN = (description: string): PropertySpec => ({ type: 'number', description })
const SB = (description: string): PropertySpec => ({ type: 'boolean', description })
const SI = (description: string): PropertySpec => ({ type: 'integer', description })
const REQ_S = (description: string): PropertySpec => ({ type: 'string', required: true, description })
const REQ_N = (description: string): PropertySpec => ({ type: 'number', required: true, description })
const REQ_B = (description: string): PropertySpec => ({ type: 'boolean', required: true, description })

const TAB_ID = S('Tab id from surfbird_tabs (targetId string). Omit to use the current tab.')
const TIMEOUT = SN('Timeout in milliseconds (default 30000 for wait; CDP calls use requestTimeoutMs).')
const TARGET: PropertySpec = {
  type: 'object',
  description: 'Element target: provide exactly one of ref (eN from surfbird_snapshot), selector (CSS), or x+y coordinates.',
  properties: {
    ref: SN('Element ref id (e.g. 3 for [e3]) from the latest surfbird_snapshot of this tab.'),
    selector: S('CSS selector.'),
    x: SN('Viewport x coordinate.'),
    y: SN('Viewport y coordinate.'),
  },
  additionalProperties: false,
}

export interface ToolsDeps {
  registry: SessionRegistry
  /** 每次取 session 时解析最新配置（options/env 热更）。 */
  sessionOpts: () => { endpoint?: string; token?: string; requestTimeoutMs?: number; keepaliveMs?: number }
  requestTimeoutMs: number
  outputDir?: string
  /** 配置诊断（status 用；不回显 token）。 */
  configInfo?: () => { configSource: string; endpoint: string; tokenSet: boolean; tokenFileError?: string; tokenFileEncrypted?: boolean }
  /** 状态上报回调（debug log 用）。 */
  onSessionError?: (key: string, err: unknown) => void
}

type RunFn = (sess: SessionBrowser, args: Record<string, JsonValue>, exec: ExecCtx) => Promise<JsonValue>

interface ToolDef {
  name: string
  description: string
  parameters: SpecMap
  run: RunFn
  needsTargetDoc?: boolean
}

/** OpenCode 输出须是 lossless JSON：递归剔除 undefined，非有限数转 null。 */
function stripUndef(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripUndef)
  if (isRecord(v)) {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      const y = stripUndef(x)
      if (y !== undefined) o[k] = y
    }
    return o
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return null
  return v
}

function ok(data: JsonValue): JsonValue {
  const clean = stripUndef(data)
  if (typeof clean === 'object' && clean !== null && !Array.isArray(clean)) {
    return { ok: true, ...(clean as JsonObject) }
  }
  return { ok: true, data: clean as JsonValue }
}

function fail(e: unknown): JsonValue {
  if (e instanceof SurfbirdError) {
    return { ok: false, error: { code: e.code, message: e.message, retryable: e.retryable } }
  }
  if (isBrowserResetError(e)) {
    return { ok: false, error: { code: 'browser_reset', message: e.message, retryable: true } }
  }
  const msg = e instanceof Error ? e.message : String(e)
  return { ok: false, error: { code: 'cdp_error', message: msg, retryable: false } }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

interface FilePart { uri: string; mime: string; name?: string }
type ContentPart = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

/** data: URI → pi 的 image content part。 */
function dataUriToImage(uri: string): ContentPart | undefined {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(uri)
  return m ? { type: 'image', data: m[2], mimeType: m[1] } : undefined
}

/** 信封 → pi AgentToolResult：text 直出，meta JSON 跟随，file data: URI 转 image part。 */
function toResult(value: JsonValue): AgentToolResult {
  if (isRecord(value) && typeof value.text === 'string') {
    const { file, ...rest } = value as Record<string, unknown>
    const parts: ContentPart[] = [{ type: 'text', text: value.text }]
    const meta = Object.keys(rest).length ? JSON.stringify(rest) : ''
    if (meta) parts.push({ type: 'text', text: meta })
    if (isRecord(file) && typeof file.uri === 'string') {
      const image = dataUriToImage(file.uri)
      if (image) parts.push(image)
    }
    return { content: parts, details: stripUndef(value) as JsonValue }
  }
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value)) }],
    details: isRecord(value) ? (stripUndef(value) as JsonValue) : {},
  }
}

function numArg(v: JsonValue | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined
}
function strArg(v: JsonValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function boolArg(v: JsonValue | undefined): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}
function targetArg(v: JsonValue | undefined): input.Target | undefined {
  if (!isRecord(v)) return undefined
  const t: input.Target = {}
  if (typeof v.ref === 'number') t.ref = v.ref
  if (typeof v.selector === 'string') t.selector = v.selector
  if (typeof v.x === 'number') t.x = v.x
  if (typeof v.y === 'number') t.y = v.y
  return t
}

function requireTarget(v: JsonValue | undefined): input.Target {
  const t = targetArg(v)
  if (!t) throw new SurfbirdError('cdp_error', 'target is required (ref / selector / x+y)')
  return t
}

const TOOLS: ToolDef[] = [
  {
    name: 'surfbird_status',
    description: 'Check the surfbird/kitesurf connection: engine product/version, tab count, session stats, config source. Cheap probe — call first when unsure of state. Never returns the token.',
    parameters: {},
    run: async (sess) => {
      const tabs = await sess.listTabs()
      const info = sess.browserInfo()
      const ver = info?.version ?? {}
      const cfg = activeDeps?.configInfo?.()
      return ok({
        connected: info?.isConnected ?? false,
        configSource: cfg?.configSource,
        endpoint: cfg?.endpoint,
        tokenSet: cfg?.tokenSet,
        tokenFileEncrypted: cfg?.tokenFileEncrypted,
        tokenFileError: cfg?.tokenFileError,
        configured: cfg ? !!cfg.endpoint : undefined,
        product: strOrUndef(ver.product),
        protocolVersion: strOrUndef(ver['protocol-version'] ?? ver.protocolVersion),
        webSocketDebuggerUrl: strOrUndef(ver.webSocketDebuggerUrl),
        tabs: tabs.length,
        currentTabId: sess.currentTabId,
        activeSessions: activeDeps?.registry.size() ?? 0,
        sessionAgeMs: info ? Date.now() - info.connectedAt : 0,
        sessionDeadlineInMs: info ? Math.max(0, info.sessionDeadline - Date.now()) : 0,
        capabilities: ENGINE_CAPABILITIES,
      })
    },
  },
  {
    name: 'surfbird_tabs',
    description: 'List open tabs in this session browser with url/title/attached state, plus the current tab id. Tab ids are strings — pass them back as tabId.',
    parameters: {},
    run: async (sess) => {
      const tabs = await sess.listTabs()
      return ok({ tabs: tabs.map(publicTab), currentTabId: sess.currentTabId })
    },
  },
  {
    name: 'surfbird_new_tab',
    description: 'Open a new tab (becomes current). If url is given, navigates immediately — createTarget alone does not navigate. wait=\'load\' (default when url given) blocks until load; use \'none\' to return immediately. Returns the new tab id.',
    parameters: {
      url: S('Optional URL to navigate to right after creating the tab.'),
      wait: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'stable', 'none'], description: "Wait after navigating (only with url). Default 'load'." },
      timeoutMs: TIMEOUT,
    },
    run: async (sess, args, exec) => {
      const url = strArg(args.url)
      const tab = await sess.newTab(url)
      const wait = strArg(args.wait) ?? (url ? 'load' : 'none')
      if (url && wait !== 'none') {
        await waitFor(sess, { tabId: tab.targetId, state: wait as WaitState, timeoutMs: numArg(args.timeoutMs), signal: exec.signal })
      }
      return ok({ tab: publicTab(tab), waited: url ? wait : undefined })
    },
  },
  {
    name: 'surfbird_close_tab',
    description: 'Close a tab by id. The current tab falls back to the first remaining tab.',
    parameters: { tabId: { ...TAB_ID, required: true } },
    run: async (sess, args) => {
      const tabId = strArg(args.tabId)
      if (!tabId) throw new SurfbirdError('cdp_error', 'tabId is required')
      await sess.closeTab(tabId)
      return ok({ closed: tabId })
    },
  },
  {
    name: 'surfbird_select_tab',
    description: 'Make a tab current (subsequent calls without tabId use it). Attaches the tab if needed — Target.activateTarget is a no-op in this engine, selection is client-side only.',
    parameters: { tabId: { ...TAB_ID, required: true } },
    run: async (sess, args) => {
      const tabId = strArg(args.tabId)
      if (!tabId) throw new SurfbirdError('cdp_error', 'tabId is required')
      const tab = await sess.selectTab(tabId)
      return ok({ tab: publicTab(tab) })
    },
  },
  {
    name: 'surfbird_navigate',
    description: 'Navigate the current (or given) tab to a URL — this reloads the page and loses form/dropdown state. Page.navigate returns before load finishes — pass wait=\'load\' (default) or use surfbird_wait afterwards. To check the current URL without side effects use surfbird_evaluate (location.href); surfbird_snapshot output also shows it. History APIs are not involved.',
    parameters: {
      url: REQ_S('URL to navigate to.'),
      tabId: TAB_ID,
      wait: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'stable', 'none'], description: "Wait after navigate. Default 'load'. 'none' returns immediately." },
      timeoutMs: TIMEOUT,
    },
    run: async (sess, args, exec) => {
      const url = String(args.url)
      let protocol = ''
      try { protocol = new URL(url).protocol } catch { /* relative/about: 交给引擎 */ }
      if (protocol && !['http:', 'https:', 'about:', 'data:'].includes(protocol)) {
        throw new SurfbirdError('cdp_error', `unsupported URL scheme: ${protocol} (allowed: http/https/about/data)`)
      }
      const res = await sess.navigate(url, strArg(args.tabId))
      const wait = strArg(args.wait) ?? 'load'
      if (wait !== 'none') {
        await waitFor(sess, { tabId: strArg(args.tabId), state: wait as WaitState, timeoutMs: numArg(args.timeoutMs), signal: exec.signal })
      }
      return ok({ navigated: String(args.url), frameId: strOrUndef(res.frameId), loaderId: strOrUndef(res.loaderId), errorText: strOrUndef(res.errorText), waited: wait })
    },
  },
  {
    name: 'surfbird_back',
    description: 'Go back in tab history. Errors if no back entry exists.',
    parameters: { tabId: TAB_ID, wait: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'stable', 'none'], description: "Default 'load'." } },
    run: async (sess, args, exec) => {
      const res = await sess.goHistory(strArg(args.tabId), 'back')
      const wait = strArg(args.wait) ?? 'load'
      if (wait !== 'none') await waitFor(sess, { tabId: strArg(args.tabId), state: wait as WaitState, signal: exec.signal })
      return ok({ direction: 'back', ...(res as JsonObject) })
    },
  },
  {
    name: 'surfbird_forward',
    description: 'Go forward in tab history. Errors if no forward entry exists.',
    parameters: { tabId: TAB_ID, wait: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'stable', 'none'], description: "Default 'load'." } },
    run: async (sess, args, exec) => {
      const res = await sess.goHistory(strArg(args.tabId), 'forward')
      const wait = strArg(args.wait) ?? 'load'
      if (wait !== 'none') await waitFor(sess, { tabId: strArg(args.tabId), state: wait as WaitState, signal: exec.signal })
      return ok({ direction: 'forward', ...(res as JsonObject) })
    },
  },
  {
    name: 'surfbird_reload',
    description: 'Reload the tab. hard=true bypasses cache (Page.reload ignoreCache).',
    parameters: { tabId: TAB_ID, hard: SB('Bypass cache.'), wait: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'stable', 'none'], description: "Default 'load'." } },
    run: async (sess, args, exec) => {
      const res = await sess.reload(strArg(args.tabId), { ignoreCache: boolArg(args.hard) === true })
      const wait = strArg(args.wait) ?? 'load'
      if (wait !== 'none') await waitFor(sess, { tabId: strArg(args.tabId), state: wait as WaitState, signal: exec.signal })
      return ok({ reloaded: true, ...(res as JsonObject) })
    },
  },
  {
    name: 'surfbird_wait',
    description: 'Wait for a page condition: load/domcontentloaded/url/text/text_gone/visible/hidden/enabled/networkidle/stable. url waits match substring; text waits match page innerText or a selector\'s text; visible/hidden/enabled take target(ref/selector). networkidle = no in-flight requests for ~500ms; stable = no DOM mutations for ~500ms (best for SPA/async pages before screenshot).',
    parameters: {
      state: { type: 'string', required: true, enum: ['load', 'domcontentloaded', 'url', 'text', 'text_gone', 'visible', 'hidden', 'enabled', 'networkidle', 'stable'], description: 'Condition to wait for.' },
      tabId: TAB_ID,
      url: S('For state=url: substring the final URL must contain.'),
      text: S('For state=text/text_gone: literal substring to look for.'),
      selector: S('For text/text_gone: scope to this element; for visible/hidden/enabled: element to check.'),
      target: TARGET,
      timeoutMs: TIMEOUT,
    },
    run: async (sess, args, exec) => {
      const state = String(args.state) as WaitState
      const t = targetArg(args.target)
      const res = await waitFor(sess, {
        tabId: strArg(args.tabId),
        state,
        url: strArg(args.url),
        text: strArg(args.text),
        selector: strArg(args.selector) ?? (state === 'visible' || state === 'hidden' || state === 'enabled' ? t?.selector : undefined),
        target: t?.ref,
        timeoutMs: numArg(args.timeoutMs),
        signal: exec.signal,
      })
      return ok(res as unknown as JsonObject)
    },
  },
  {
    name: 'surfbird_snapshot',
    description: 'Semantic page digest: [eN] interactive refs, [hN] headings, [tN] text blocks, plus header with title/url and docToken. Refs (eN) are valid until navigation or DOM reload — re-snapshot after any navigation. truncated/omitted tell you to narrow with selector or raise maxChars/maxNodes.',
    parameters: {
      tabId: TAB_ID,
      selector: S('Scope the snapshot to this CSS selector subtree.'),
      maxChars: SN('Character budget (default 8000).'),
      maxNodes: SN('Emitted-line budget (default 200).'),
    },
    run: async (sess, args, exec) => {
      const res = await snapshot(sess, {
        tabId: strArg(args.tabId),
        selector: strArg(args.selector),
        maxChars: numArg(args.maxChars),
        maxNodes: numArg(args.maxNodes),
        signal: exec.signal,
      })
      const { text, ...meta } = res
      return ok({ text, ...meta })
    },
  },
  {
    name: 'surfbird_ax',
    description: 'Accessibility tree as indented role:name lines (maxNodes default 300). Use when snapshot misses semantics or you need the a11y view.',
    parameters: { tabId: TAB_ID, maxNodes: SN('Line budget (default 300).') },
    run: async (sess, args, exec) => {
      const res = await axTree(sess, { tabId: strArg(args.tabId), maxNodes: numArg(args.maxNodes), signal: exec.signal })
      const { text, ...meta } = res
      return ok({ text, ...meta })
    },
  },
  {
    name: 'surfbird_click',
    description: 'Click an element (ref/selector/coordinates). The engine may swallow input errors — always verify with surfbird_wait or surfbird_snapshot afterwards. Clicks that trigger navigation are async: follow with surfbird_wait state=load.',
    parameters: { target: { ...TARGET, required: true }, tabId: TAB_ID },
    run: async (sess, args, exec) => {
      const r = await sess.resolveTab(strArg(args.tabId))
      const p = await input.click(sess, r, requireTarget(args.target), { signal: exec.signal })
      return ok({ clicked: true, x: p.x, y: p.y, note: 'verify effect with surfbird_wait/surfbird_snapshot — engine swallows some input errors' })
    },
  },
  {
    name: 'surfbird_double_click',
    description: 'Double-click an element. Same caveats as surfbird_click.',
    parameters: { target: { ...TARGET, required: true }, tabId: TAB_ID },
    run: async (sess, args, exec) => {
      const r = await sess.resolveTab(strArg(args.tabId))
      const p = await input.click(sess, r, requireTarget(args.target), { double: true, signal: exec.signal })
      return ok({ doubleClicked: true, x: p.x, y: p.y, note: 'verify effect with surfbird_wait/surfbird_snapshot' })
    },
  },
  {
    name: 'surfbird_fill',
    description: 'Set an input/textarea/select value directly (Kitesurf.setControlValue, falls back to DOM value+events). Replaces existing content — use surfbird_type to append keystrokes instead.',
    parameters: {
      target: { ...TARGET, required: true },
      value: REQ_S('Value to set.'),
      tabId: TAB_ID,
    },
    run: async (sess, args, exec) => {
      const r = await sess.resolveTab(strArg(args.tabId))
      const res = await input.fill(sess, r, requireTarget(args.target), String(args.value), exec.signal)
      return ok({ filled: res.changed, method: res.method, ...(res.error ? { error: res.error } : {}) })
    },
  },
  {
    name: 'surfbird_type',
    description: 'Type text into the focused element (or into target after focusing it). Uses Input.insertText — fast but does not fire full key events (engine KeyboardEvent support is incomplete). For special keys use surfbird_press_key; for replacing a value prefer surfbird_fill.',
    parameters: {
      text: REQ_S('Text to insert.'),
      target: TARGET,
      tabId: TAB_ID,
    },
    run: async (sess, args, exec) => {
      const r = await sess.resolveTab(strArg(args.tabId))
      const t = targetArg(args.target)
      await input.typeText(sess, r, t ?? {}, String(args.text), exec.signal)
      return ok({ typed: String(args.text).length })
    },
  },
  {
    name: 'surfbird_press_key',
    description: 'Press a single key: letters a-z, digits 0-9, enter/tab/escape/backspace/delete/space/arrows/home/end/pageup/pagedown/shift/control/alt/meta/f1-f12 and common punctuation. modifiers is a CDP bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8).',
    parameters: {
      key: REQ_S('Key name (e.g. enter, tab, escape, a, arrowdown).'),
      modifiers: SN('CDP modifiers bitmask: Alt=1 Ctrl=2 Meta=4 Shift=8.'),
      target: TARGET,
      tabId: TAB_ID,
    },
    run: async (sess, args, exec) => {
      const r = await sess.resolveTab(strArg(args.tabId))
      const t = targetArg(args.target)
      if (t) await input.click(sess, r, t, { signal: exec.signal }).catch(() => undefined)
      await input.pressKey(sess, r, String(args.key), { modifiers: numArg(args.modifiers), signal: exec.signal })
      return ok({ pressed: String(args.key) })
    },
  },
  {
    name: 'surfbird_scroll',
    description: 'Scroll: deltaX/deltaY wheel scroll (pixels, dy positive = down), or target(ref/selector) to scrollIntoView.',
    parameters: {
      deltaX: SN('Horizontal delta (default 0).'),
      deltaY: SN('Vertical delta (default 600; positive scrolls down).'),
      target: TARGET,
      tabId: TAB_ID,
    },
    run: async (sess, args, exec) => {
      const r = await sess.resolveTab(strArg(args.tabId))
      const res = await input.scroll(sess, r, { deltaX: numArg(args.deltaX), deltaY: numArg(args.deltaY), target: targetArg(args.target), signal: exec.signal })
      return ok(res as unknown as JsonObject)
    },
  },
  {
    name: 'surfbird_screenshot',
    description: 'Capture the tab viewport, a page rect via clip, or a single element via target(ref/selector)+padding (or fullPage via temporary viewport resize — engine has no captureBeyondViewport). Returns the image inlined as an attachment plus a saved path; text-only models cannot see it — use snapshot/extract/wait for self-verification. Writes to screenshotDir/tmp. Engine returns placeholder+error field on failure — the tool checks it. Dimensions clamp to engine limits (side ≤2560, ≤2560×1440 px).',
    parameters: {
      tabId: TAB_ID,
      fullPage: SB('Resize viewport to full content size before capture (clamped to engine limits), then restore.'),
      format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: "Image format (default png)." },
      quality: SN('JPEG/WebP quality 0-100.'),
      clip: {
        type: 'object',
        description: 'Capture only this page rect {x,y,width,height} (CSS pixels, document-absolute).',
        properties: {
          x: REQ_N('Left edge (page coordinates).'),
          y: REQ_N('Top edge (page coordinates).'),
          width: REQ_N('Width in px (clamped to engine limits).'),
          height: REQ_N('Height in px (clamped to engine limits).'),
        },
        additionalProperties: false,
      },
      target: {
        type: 'object',
        description: 'Capture only this element — ref (eN from surfbird_snapshot) or selector. Computes the element\'s document-space bounding box and clips to it (mutually exclusive with clip; padding adds px around the box).',
        properties: {
          ref: SN('Element ref id from the latest surfbird_snapshot of this tab.'),
          selector: S('CSS selector.'),
        },
        additionalProperties: false,
      },
      padding: SN('Extra pixels around a target element clip (default 0).'),
      waitFor: { type: 'string', enum: ['none', 'load', 'domcontentloaded', 'networkidle', 'stable'], description: "Wait for this state before capturing (default 'load'). Use 'networkidle' or 'stable' for SPA/async pages that keep mutating after load; 'none' captures immediately." },
      timeoutMs: TIMEOUT,
    },
    run: async (sess, args, exec) => screenshot(sess, activeDeps!, args, exec),
  },
  {
    name: 'surfbird_pdf',
    description: 'Print the tab to PDF (Page.printToPDF). Saves to screenshotDir/tmp and returns the path + size — PDFs are not inlined as attachments. Engine failures come back as {data, error} — checked. paperWidth/Height are inches; preferCSSPageSize honors the page\'s own @page size.',
    parameters: {
      tabId: TAB_ID,
      landscape: SB('Landscape orientation.'),
      paperWidth: SN('Paper width in inches.'),
      paperHeight: SN('Paper height in inches.'),
      preferCSSPageSize: SB('Use the document\'s CSS @page size over paperWidth/Height.'),
      omitBackground: SB('Omit background graphics.'),
      printBackground: SB('Include background graphics (default true).'),
      marginTop: SN('Top margin in inches.'),
      marginBottom: SN('Bottom margin in inches.'),
      marginLeft: SN('Left margin in inches.'),
      marginRight: SN('Right margin in inches.'),
      waitFor: { type: 'string', enum: ['none', 'load', 'domcontentloaded', 'networkidle', 'stable'], description: "Wait for this state before printing (default 'load')." },
      timeoutMs: TIMEOUT,
    },
    run: async (sess, args, exec) => pdf(sess, activeDeps!, args, exec),
  },
  {
    name: 'surfbird_evaluate',
    description: 'Run JavaScript in the tab and return the JSON value. awaitPromise=true awaits returned promises. Use for DOM queries, state reads, and custom logic snapshot cannot express. Exceptions return as errors.',
    parameters: {
      expression: REQ_S('JavaScript expression to evaluate.'),
      tabId: TAB_ID,
      awaitPromise: SB('Await a returned promise.'),
    },
    run: async (sess, args, exec) => {
      const r = await sess.resolveTab(strArg(args.tabId))
      const value = await sess.evaluate(r, String(args.expression), { awaitPromise: boolArg(args.awaitPromise) === true, signal: exec.signal })
      return ok({ result: value ?? null })
    },
  },
  {
    name: 'surfbird_extract',
    description: 'Extract the main article as Markdown (Readability + Turndown). Best for articles/docs; returns no_article on non-article pages — fall back to surfbird_snapshot.',
    parameters: { tabId: TAB_ID, maxChars: SN('Markdown character cap (default 50000).') },
    run: async (sess, args, exec) => {
      const res = await extract(sess, { tabId: strArg(args.tabId), maxChars: numArg(args.maxChars), signal: exec.signal })
      const { content, markdown, ...meta } = res
      void markdown
      return ok({ text: res.markdown, ...meta, contentChars: content.length })
    },
  },
  {
    name: 'surfbird_find',
    description: 'In-page text search (like Ctrl+F) over visible text — skips script/style/hidden subtrees. Use to check whether specific text appears on the page, count occurrences, or step through matches: returns {count,index,snippet} and scrolls the match into view (no visual highlight — pair with surfbird_screenshot or surfbird_extract). action=first|next|prev walks matches (state persists per document), count returns total only, clear resets; caseSensitive/wholeWord flags. Searches only text already rendered on the current page — it does NOT submit the site\'s own search form (use surfbird_fill + surfbird_press_key enter for that).',
    parameters: {
      text: REQ_S('Text to find.'),
      action: { type: 'string', enum: ['first', 'next', 'prev', 'count', 'clear'], description: "Default 'first'." },
      caseSensitive: SB('Case-sensitive matching (default false).'),
      wholeWord: SB('Match whole words only (default false).'),
      tabId: TAB_ID,
    },
    run: async (sess, args, exec) => {
      const r = await sess.resolveTab(strArg(args.tabId))
      const action = strArg(args.action) ?? 'first'
      if (!['first', 'next', 'prev', 'count', 'clear'].includes(action)) {
        throw new SurfbirdError('bad_args', `invalid action: ${action}`)
      }
      const value = await sess.evaluate(r, buildFindExpression({
        text: String(args.text ?? ''),
        action: action as 'first' | 'next' | 'prev' | 'count' | 'clear',
        caseSensitive: boolArg(args.caseSensitive),
        wholeWord: boolArg(args.wholeWord),
      }), { returnByValue: true, signal: exec.signal })
      return ok(value as JsonValue)
    },
  },
  {
    name: 'surfbird_links',
    description: 'Extract all links on the page as {url,text} pairs (absolute URLs, textContent trimmed to 160 chars). Dedupe is by full URL including #hash by default — pass dedupe=\'base\' to ignore fragments (e.g. many in-page anchors to the same document). selector scopes extraction to a subtree; limit caps results (default 200). Cheaper than evaluate for "what links are here" questions.',
    parameters: {
      tabId: TAB_ID,
      selector: S('Scope to links inside this CSS selector subtree.'),
      limit: SN('Max links to return (default 200, cap 500).'),
      dedupe: { type: 'string', enum: ['url', 'base'], description: "Dedup key: 'url' = full href incl. hash (default); 'base' = strip #fragment first." },
    },
    run: async (sess, args, exec) => {
      const r = await sess.resolveTab(strArg(args.tabId))
      const dedupe = strArg(args.dedupe)
      const value = await sess.evaluate(r, buildLinksExpression({
        selector: strArg(args.selector),
        limit: numArg(args.limit),
        dedupe: dedupe === 'base' ? 'base' : 'url',
      }), { returnByValue: true, signal: exec.signal })
      return ok(value as JsonValue)
    },
  },
  {
    name: 'surfbird_webmcp',
    description: 'WebMCP: tools the PAGE registered about itself via document.modelContext (pages declare capabilities like "search"/"add-to-cart" instead of you guessing the DOM). action=list returns [{name,description,inputSchema,annotations}]; action=invoke calls one (input is a JSON object matching inputSchema) and waits for the result — status Completed/Error/Canceled with the tool\'s output; action=cancel aborts a pending invocation by invocationId. Most pages register nothing — empty list is normal. Requires Kitesurf engine (upstream kitesurf also supports it).',
    parameters: {
      action: { type: 'string', enum: ['list', 'invoke', 'cancel'], description: "Default 'list'." },
      tool: S('Tool name (required for invoke).'),
      input: { type: 'json', description: 'Input object for invoke, matching the tool\'s inputSchema.' },
      invocationId: S('Invocation id (required for cancel).'),
      tabId: TAB_ID,
      timeoutMs: SN('Max wait for an invoke result in ms (default 60000).'),
    },
    run: async (sess, args, exec) => {
      const r = await sess.resolveTab(strArg(args.tabId))
      const action = strArg(args.action) ?? 'list'
      if (action === 'list') {
        const tools = await sess.webmcpList(r, exec.signal)
        return ok({ tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })) as unknown as JsonValue, count: tools.length })
      }
      if (action === 'invoke') {
        const tool = strArg(args.tool)
        if (!tool) throw new SurfbirdError('bad_args', 'tool is required for action=invoke')
        const input = isRecord(args.input) ? (args.input as JsonObject) : undefined
        const res = await sess.webmcpInvoke(r, tool, input, { timeoutMs: numArg(args.timeoutMs), signal: exec.signal })
        return ok(res as unknown as JsonValue)
      }
      if (action === 'cancel') {
        const invocationId = strArg(args.invocationId)
        if (!invocationId) throw new SurfbirdError('bad_args', 'invocationId is required for action=cancel')
        await sess.webmcpCancel(r, invocationId, exec.signal)
        return ok({ canceled: invocationId })
      }
      throw new SurfbirdError('bad_args', `invalid action: ${action}`)
    },
  },
  {
    name: 'surfbird_console',
    description: 'Read captured console messages/exceptions for the current tab. since=nextSince cursor for incremental reads; only=errors filters to error/exception/assert; clear=true resets the buffer. Events are captured from tab attach onward.',
    parameters: {
      tabId: TAB_ID,
      since: SN('Cursor from a previous call (nextSince).'),
      only: { type: 'string', enum: ['errors'], description: "Filter to errors only." },
      clear: SB('Clear the buffer after reading.'),
      limit: SN('Max entries to return (default 100, cap 500).'),
    },
    run: async (sess, args) => {
      const r = await sess.resolveTab(strArg(args.tabId))
      const buf = sess.buffersFor(r.sessionId)?.console
      if (!buf) return ok({ entries: [], note: 'no console buffer for this tab' })
      const res = buf.read({ since: numArg(args.since), only: strArg(args.only) })
      const limit = Math.min(numArg(args.limit) ?? 100, 500)
      const entries = res.entries.slice(-limit)
      if (boolArg(args.clear)) buf.clear()
      return ok({ entries: entries as unknown as JsonValue, nextSince: res.nextSince, dropped: res.dropped })
    },
  },
  {
    name: 'surfbird_network',
    description: 'Read captured network requests (url/method/status/mime/size/failure). action=body+requestId fetches a response body (engine retains ~256KB/body). sinceIndex=nextIndex for incremental reads; clear=true resets.',
    parameters: {
      tabId: TAB_ID,
      action: { type: 'string', enum: ['list', 'body'], description: "Default 'list'." },
      requestId: S('Required for action=body.'),
      sinceIndex: SN('Cursor from a previous list call (nextIndex).'),
      clear: SB('Clear the buffer after reading.'),
      limit: SN('Max entries to return (default 100, cap 500).'),
    },
    run: async (sess, args, exec) => {
      const r = await sess.resolveTab(strArg(args.tabId))
      const buf = sess.buffersFor(r.sessionId)?.network
      if (!buf) return ok({ entries: [], note: 'no network buffer for this tab' })
      if (strArg(args.action) === 'body') {
        const requestId = strArg(args.requestId)
        if (!requestId) throw new SurfbirdError('cdp_error', 'requestId is required for action=body')
        const res = await sess.cdp('Network.getResponseBody', { requestId }, { sessionId: r.sessionId, signal: exec.signal })
        return ok({ requestId, body: strOrUndef(res.body) ?? '', base64Encoded: res.base64Encoded === true })
      }
      const res = buf.read({ sinceIndex: numArg(args.sinceIndex) })
      const limit = Math.min(numArg(args.limit) ?? 100, 500)
      const entries = res.entries.slice(-limit)
      if (boolArg(args.clear)) buf.clear()
      return ok({ entries: entries as unknown as JsonValue, nextIndex: res.nextIndex, total: res.total })
    },
  },
  {
    name: 'surfbird_cdp',
    description: 'Raw CDP escape hatch: send any method with params. tabId scopes to that tab\'s session; omit tabId for browser-level methods (Target.*, Browser.*). Prefer dedicated tools — raw calls bypass doc-token/ref safety and engine quirks are yours to handle.',
    parameters: {
      method: REQ_S('CDP method, e.g. Page.getLayoutMetrics or DOM.getBoxModel.'),
      params: { type: 'json', description: 'Method params object.' },
      tabId: TAB_ID,
      sessionId: S('Explicit sessionId (rarely needed — prefer tabId).'),
      noSession: SB('Send without sessionId (browser-domain methods only).'),
    },
    run: async (sess, args, exec) => {
      const params = isRecord(args.params) ? (args.params as JsonObject) : undefined
      const res = await sess.cdp(String(args.method), params, {
        tabId: strArg(args.tabId),
        sessionId: strArg(args.sessionId),
        noSession: boolArg(args.noSession) === true,
        signal: exec.signal,
      })
      return ok({ result: res ?? null })
    },
  },
]

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** Kitesurf 引擎能力矩阵（design.md §8 边界的机器可读版）——status 直出，模型自适应。 */
const ENGINE_CAPABILITIES: JsonObject = {
  webmcp: true,
  pdf: true,
  screenshot: { clip: true, elementTarget: true, fullPage: 'viewport-resize', maxSide: 2560, maxPixels: 2560 * 1440 },
  input: { mouse: true, keyboard: 'partial', insertText: true, setControlValue: true },
  waits: ['load', 'domcontentloaded', 'url', 'text', 'text_gone', 'visible', 'hidden', 'enabled', 'networkidle', 'stable'],
  unsupported: ['dialogs', 'fileUpload', 'fileDownload', 'clipboard', 'drag', 'touch'],
}

function publicTab(t: { targetId: string; url: string; title: string; type?: string; sessionId?: string }): JsonObject {
  return { tabId: t.targetId, url: t.url, title: t.title, type: t.type ?? 'page', attached: !!t.sessionId }
}

let activeDeps: ToolsDeps | undefined
let fileSeq = 0
function uniqueName(prefix: string, ext: string): string {
  return `${prefix}-${Date.now()}-${++fileSeq}.${ext}`
}

// 与引擎 packages/engine/src/cdp/viewport.ts 一致的钳制：边长 ≤2560，总像素 ≤2560×1440
const VP_MAX_SIDE = 2560
const VP_MAX_PIXELS = 2560 * 1440
const VP_MIN = 16
function clampVp(w: number, h: number): { width: number; height: number } {
  let width = Math.max(VP_MIN, Math.min(VP_MAX_SIDE, Math.floor(w)))
  let height = Math.max(VP_MIN, Math.min(VP_MAX_SIDE, Math.floor(h)))
  const px = width * height
  if (px > VP_MAX_PIXELS) {
    const scale = Math.sqrt(VP_MAX_PIXELS / px)
    width = Math.max(VP_MIN, Math.floor(width * scale))
    height = Math.max(VP_MIN, Math.floor(height * scale))
  }
  return { width, height }
}

function numOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function clipArg(v: JsonValue | undefined): { x: number; y: number; width: number; height: number } | undefined {
  if (!isRecord(v)) return undefined
  const x = numOf(v.x), y = numOf(v.y), w = numOf(v.width), h = numOf(v.height)
  if (x === undefined || y === undefined || w === undefined || h === undefined || w <= 0 || h <= 0) return undefined
  const c = clampVp(w, h)
  return { x, y, width: c.width, height: c.height }
}

async function screenshot(sess: SessionBrowser, deps: ToolsDeps, args: Record<string, JsonValue>, exec: ExecCtx): Promise<JsonValue> {
  const r = await sess.resolveTab(strArg(args.tabId))
  const waitState = strArg(args.waitFor) ?? 'load'
  if (waitState !== 'none') {
    await waitFor(sess, { tabId: strArg(args.tabId), state: waitState as WaitState, timeoutMs: numArg(args.timeoutMs), signal: exec.signal })
  }
  const format = strArg(args.format) ?? 'png'
  const params: JsonObject = { format }
  if (format !== 'png') {
    const q = numArg(args.quality)
    if (q !== undefined) params.quality = Math.max(0, Math.min(100, Math.round(q)))
  }
  let clip = clipArg(args.clip)
  const elTarget = targetArg(args.target)
  if (elTarget && clip) throw new SurfbirdError('bad_args', 'target and clip are mutually exclusive')
  if (elTarget) {
    if (elTarget.x !== undefined || elTarget.y !== undefined) {
      throw new SurfbirdError('bad_args', 'screenshot target requires ref or selector (coordinates unsupported)')
    }
    const nodeId = await input.resolveNodeId(sess, r, elTarget, exec.signal)
    if (nodeId === undefined) throw new SurfbirdError('bad_args', 'screenshot target requires ref or selector')
    const rect = await input.elementRect(sess, r, nodeId, exec.signal)
    const pad = Math.max(0, numArg(args.padding) ?? 0)
    const x = Math.max(0, rect.x - pad)
    const y = Math.max(0, rect.y - pad)
    const c = clampVp(rect.width + pad * 2, rect.height + pad * 2)
    clip = { x, y, width: c.width, height: c.height }
  }
  if (clip) params.clip = clip

  // fullPage：引擎无 captureBeyondViewport——临时把 viewport 拉伸到内容尺寸
  // （setDeviceMetricsOverride 内部同样走 clampViewport），截完必须手动恢复
  // （无 clearDeviceMetricsOverride，且它是静默 no-op）
  const fullPage = boolArg(args.fullPage) === true
  let restore: { width: number; height: number } | undefined
  let resized: { width: number; height: number } | undefined
  if (fullPage) {
    const metrics = await sess.cdp('Page.getLayoutMetrics', {}, { sessionId: r.sessionId, signal: exec.signal })
    const cs = (metrics.cssContentSize ?? metrics.contentSize ?? {}) as JsonObject
    const lv = (metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {}) as JsonObject
    const cw = numOf(cs.width), ch = numOf(cs.height)
    const vw = numOf(lv.clientWidth), vh = numOf(lv.clientHeight)
    if (cw !== undefined && ch !== undefined && cw > 0 && ch > 0) {
      resized = clampVp(cw, ch)
      restore = vw !== undefined && vh !== undefined ? { width: vw, height: vh } : undefined
      await sess.cdp('Emulation.setDeviceMetricsOverride',
        { width: resized.width, height: resized.height, deviceScaleFactor: 1, mobile: false },
        { sessionId: r.sessionId, signal: exec.signal })
    }
  }

  let res: JsonObject
  try {
    res = await sess.cdp('Page.captureScreenshot', params, { sessionId: r.sessionId, signal: exec.signal })
  } finally {
    if (restore && resized) {
      await sess.cdp('Emulation.setDeviceMetricsOverride',
        { width: restore.width, height: restore.height, deviceScaleFactor: 1, mobile: false },
        { sessionId: r.sessionId }).catch(() => { /* 恢复失败不掩盖截图结果 */ })
    }
  }
  const err = strOrUndef(res.error)
  if (err) throw new SurfbirdError('cdp_error', `screenshot failed: ${err}`)
  const data = strOrUndef(res.data)
  if (!data) throw new SurfbirdError('cdp_error', 'screenshot returned no data')
  const buf = Buffer.from(data, 'base64')
  const mediaType = format === 'jpeg' ? 'image/jpeg' : `image/${format}`
  const name = uniqueName('surfbird', format === 'jpeg' ? 'jpg' : format)

  const dir = deps.outputDir ?? join(tmpdir(), 'surfbird')
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, buf)
  // OpenCode ≤2.2.x stores tool-result file parts verbatim and rejects `file:` URIs
  // at LLM compile time — one such result kills every later turn of the session
  // (anomalyco/opencode#62870). Inline as a data: URI instead; oversized images
  // fall back to path-only so the base64 is not replayed on every turn.
  const inline = buf.length <= 8 * 1024 * 1024
  return ok({
    text: `Screenshot ${buf.length} bytes (${format}${fullPage ? `, fullPage ${resized?.width ?? '?'}x${resized?.height ?? '?'}` : ''}${clip ? ', clipped' : ''}) saved to ${path}.${inline ? '' : ' Too large to inline — open the path directly.'}`,
    path,
    bytes: buf.length,
    format,
    ...(inline ? { file: { uri: `data:${mediaType};base64,${buf.toString('base64')}`, mime: mediaType, name } satisfies FilePart } : {}),
  })
}

async function pdf(sess: SessionBrowser, deps: ToolsDeps, args: Record<string, JsonValue>, exec: ExecCtx): Promise<JsonValue> {
  const r = await sess.resolveTab(strArg(args.tabId))
  const waitState = strArg(args.waitFor) ?? 'load'
  if (waitState !== 'none') {
    await waitFor(sess, { tabId: strArg(args.tabId), state: waitState as WaitState, timeoutMs: numArg(args.timeoutMs), signal: exec.signal })
  }
  const params: JsonObject = {
    landscape: boolArg(args.landscape) === true,
    printBackground: boolArg(args.printBackground) !== false,
  }
  for (const k of ['paperWidth', 'paperHeight', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight'] as const) {
    const v = numArg(args[k])
    if (v !== undefined) params[k] = v
  }
  if (boolArg(args.preferCSSPageSize)) params.preferCSSPageSize = true
  if (boolArg(args.omitBackground)) params.omitBackground = true
  const res = await sess.cdp('Page.printToPDF', params, { sessionId: r.sessionId, signal: exec.signal })
  const err = strOrUndef(res.error)
  if (err) throw new SurfbirdError('cdp_error', `printToPDF failed: ${err}`)
  const data = strOrUndef(res.data)
  if (!data) throw new SurfbirdError('cdp_error', 'printToPDF returned no data')
  const buf = Buffer.from(data, 'base64')
  const dir = deps.outputDir ?? join(tmpdir(), 'surfbird')
  await mkdir(dir, { recursive: true })
  const name = uniqueName('surfbird', 'pdf')
  const path = join(dir, name)
  await writeFile(path, buf)
  // No file part: `file:` URIs kill the session (opencode#62870) and inlined
  // `data:application/pdf` is rejected by providers without PDF support.
  return ok({
    text: `PDF saved to ${path} (${buf.length} bytes).`,
    path,
    bytes: buf.length,
  })
}

export function registerSurfbirdTools(pi: ExtensionAPI, deps: ToolsDeps): void {
  activeDeps = deps
  for (const def of TOOLS) {
    pi.registerTool({
      name: def.name,
      label: def.name,
      description: def.description,
      parameters: specToTypeBox(def.parameters),
      async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionToolContext): Promise<AgentToolResult> {
        const key = ctx.sessionManager.getSessionId() ?? 'default'
        const exec: ExecCtx = { signal, sessionID: key }
        let sess: SessionBrowser
        try {
          sess = deps.registry.get(key, deps.sessionOpts())
        } catch (e) {
          return toResult(fail(e))
        }
        try {
          return await sess.enqueue(async () => {
            try {
              return toResult(await def.run(sess, params as Record<string, JsonValue>, exec))
            } catch (e) {
              deps.onSessionError?.(key, e)
              return toResult(fail(e))
            }
          })
        } catch (e) {
          return toResult(fail(e))
        }
      },
    })
  }
}
