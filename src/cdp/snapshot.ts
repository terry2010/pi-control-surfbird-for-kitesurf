/**
 * src/cdp/snapshot.ts — DOM.getDocument → 语义 digest + eN ref。
 *
 * 引擎事实（design.md §5.4/§9）：
 * - DOM.getDocument 的 depth 参数被忽略，恒返回全量树 → 单次调用+客户端遍历
 * - 护栏：嵌套 ≤767 层、容器 ≤2^20；本模块另设 visited 上限防御
 * - nodeId 与 backendNodeId 同命名空间 → ref 直接存 nodeId
 * - 文本节点内容在 nodeValue（nodeName='#text'），兼容两者
 * - 预算截断必须报 omitted 计数（学 pcc compact 语义）
 */

import type { SessionBrowser, ResolvedTab } from './session.ts'
import { SurfbirdError, type JsonObject, type RefEntry } from './types.ts'

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'svg', 'math', 'iframe'])
const INTERACTIVE_TAGS = new Set(['button', 'select', 'textarea', 'summary', 'option', 'details'])
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'switch', 'textbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'searchbox',
  'treeitem', 'gridcell', 'row', 'columnheader', 'rowheader',
])
const INPUT_ROLES: Record<string, string> = {
  checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button',
  image: 'button', range: 'slider', number: 'spinbutton', search: 'searchbox',
}

const DEFAULT_MAX_CHARS = 8000
const DEFAULT_MAX_NODES = 200
/** 访问节点硬上限——远超引擎 2^20 护栏前的防御，防止病态页面拖死遍历。 */
const MAX_VISITED = 120_000

interface DomNode {
  nodeId: number
  nodeType?: number
  nodeName?: string
  nodeValue?: string
  localName?: string
  attributes?: string[]
  children?: DomNode[]
  contentDocument?: DomNode
}

interface PathSeg {
  tag: string
  index: number
}

export interface SnapshotOptions {
  tabId?: string
  selector?: string
  maxChars?: number
  maxNodes?: number
  signal?: AbortSignal
}

export interface SnapshotResult {
  text: string
  tabId: string
  url: string
  title: string
  docToken: string
  refs: number
  omitted: number
  truncated: boolean
  visited: number
}

interface Ctx {
  sess: SessionBrowser
  tab: ResolvedTab
  out: string[]
  chars: number
  emitted: number
  candidates: number
  textSeq: number
  refs: RefEntry[]
  maxChars: number
  maxNodes: number
  truncated: boolean
  visited: number
}

function attrs(node: DomNode): Map<string, string> {
  const m = new Map<string, string>()
  const a = node.attributes ?? []
  for (let i = 0; i + 1 < a.length; i += 2) m.set(a[i].toLowerCase(), a[i + 1])
  return m
}

function tagOf(node: DomNode): string {
  return (node.localName ?? node.nodeName ?? '').toLowerCase()
}

function textOf(node: DomNode): string {
  return node.nodeValue ?? node.nodeName ?? ''
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 元素的可访问名近似：aria-label/placeholder/alt/title/value > 后代文本。 */
function accessibleName(node: DomNode, tag: string, at: Map<string, string>): string {
  const direct = at.get('aria-label') ?? at.get('placeholder') ?? at.get('alt') ?? at.get('title')
  if (direct) return collapseWs(direct).slice(0, 80)
  if (tag === 'input') {
    const v = at.get('value')
    if (v) return collapseWs(v).slice(0, 80)
  }
  let text = ''
  const collect = (n: DomNode, depth: number): void => {
    if (text.length > 80 || depth > 6) return
    const t = n.nodeType ?? 0
    if (t === 3) {
      text += ' ' + textOf(n)
      return
    }
    if (t !== 1 && t !== 9 && t !== 11) return
    if (SKIP_TAGS.has(tagOf(n))) return
    for (const c of n.children ?? []) collect(c, depth + 1)
  }
  for (const c of node.children ?? []) collect(c, 0)
  return collapseWs(text).slice(0, 80)
}

function roleOf(node: DomNode, tag: string, at: Map<string, string>): string {
  const explicit = at.get('role')
  if (explicit && INTERACTIVE_ROLES.has(explicit)) return explicit
  if (tag === 'a') return 'link'
  if (tag === 'button' || tag === 'summary') return 'button'
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'
  if (tag === 'input') return INPUT_ROLES[(at.get('type') ?? 'text').toLowerCase()] ?? 'textbox'
  if (tag === 'option') return 'option'
  return tag
}

function isInteractive(node: DomNode, tag: string, at: Map<string, string>): boolean {
  if (tag === 'input') return (at.get('type') ?? 'text').toLowerCase() !== 'hidden'
  if (tag === 'a') return at.has('href')
  if (INTERACTIVE_TAGS.has(tag)) return true
  const role = at.get('role')
  if (role && INTERACTIVE_ROLES.has(role)) return true
  if (at.has('onclick') || at.has('tabindex')) return true
  return false
}

function cssPath(segs: PathSeg[]): string {
  return segs.map((s) => `${s.tag}:nth-of-type(${s.index})`).join('>')
}

function emit(ctx: Ctx, line: string): void {
  ctx.candidates += 1
  const len = line.length + 1
  if (ctx.emitted >= ctx.maxNodes || ctx.chars + len > ctx.maxChars) {
    ctx.truncated = true
    return
  }
  ctx.out.push(line)
  ctx.chars += len
  ctx.emitted += 1
}

/**
 * 递归遍历。segs = 当前节点的完整 CSS 路径段（元素自身已含）；
 * insideSkippable=true 时抑制文本行（交互/标题元素内部文本已被名字覆盖）。
 */
function visit(ctx: Ctx, node: DomNode, segs: PathSeg[], insideSkippable: boolean): void {
  if (ctx.visited >= MAX_VISITED) {
    ctx.truncated = true
    return
  }
  ctx.visited += 1
  const type = node.nodeType ?? 0

  if (type === 3) {
    if (!insideSkippable) {
      const text = collapseWs(textOf(node))
      if (text.length >= 2) {
        ctx.textSeq += 1
        emit(ctx, `[t${ctx.textSeq}] ${text.slice(0, 120)}`)
      }
    }
    return
  }
  if (type !== 1 && type !== 9 && type !== 11) return

  let childSkippable = insideSkippable
  if (type === 1) {
    const tag = tagOf(node)
    if (SKIP_TAGS.has(tag)) return
    const at = attrs(node)

    const heading = /^h[1-6]$/.test(tag) ? Number(tag[1]) : 0
    if (heading) {
      const text = collapseWs(accessibleName(node, tag, at))
      if (text) emit(ctx, `[h${heading}] ${text.slice(0, 120)}`)
      childSkippable = true
    } else if (isInteractive(node, tag, at)) {
      const name = accessibleName(node, tag, at)
      const role = roleOf(node, tag, at)
      const href = tag === 'a' ? at.get('href') : undefined
      const path = cssPath(segs)
      const label = name ? ` "${name}"` : ''
      const arrow = href ? ` → ${href.slice(0, 200)}` : ''
      // 预算预检通过才 mint——被截断的元素不占 ref 位（模型看不到的 eN 没有意义）
      const rid = ctx.sess.peekRefId()
      const line = `[e${rid}] ${role}${label}${arrow}`
      ctx.candidates += 1
      if (ctx.emitted >= ctx.maxNodes || ctx.chars + line.length + 1 > ctx.maxChars) {
        ctx.truncated = true
      } else {
        const ref = ctx.sess.mintRef(ctx.tab.tab, node.nodeId, path || undefined, tag.toUpperCase())
        ctx.refs.push(ref)
        ctx.out.push(line)
        ctx.chars += line.length + 1
        ctx.emitted += 1
      }
      childSkippable = true
    }
  }

  // 子节点遍历：元素子节点按同名 nth-of-type 计数生成路径段
  const counts = new Map<string, number>()
  for (const c of node.children ?? []) {
    if ((c.nodeType ?? 0) === 1) {
      const ctag = tagOf(c)
      const idx = (counts.get(ctag) ?? 0) + 1
      counts.set(ctag, idx)
      visit(ctx, c, [...segs, { tag: ctag, index: idx }], childSkippable)
    } else {
      visit(ctx, c, segs, childSkippable)
    }
  }
}

export async function snapshot(sess: SessionBrowser, opts: SnapshotOptions = {}): Promise<SnapshotResult> {
  const r = await sess.resolveTab(opts.tabId)
  const doc = await sess.cdp('DOM.getDocument', { depth: -1 }, { sessionId: r.sessionId, signal: opts.signal })
  const root = (doc.root ?? {}) as unknown as DomNode

  // selector 作用域：先 querySelector 定位子树根（带完整路径段，保证 ref selector 可从文档根重查）
  let scope = root
  let scopeSegs: PathSeg[] = []
  if (opts.selector) {
    const q = await sess.cdp('DOM.querySelector', { nodeId: root.nodeId, selector: opts.selector }, { sessionId: r.sessionId, signal: opts.signal })
    const nodeId = typeof q.nodeId === 'number' ? q.nodeId : 0
    if (!nodeId) throw new SurfbirdError('cdp_error', `selector matched nothing: ${opts.selector}`)
    const found = findWithPath(root, nodeId, [])
    if (!found) throw new SurfbirdError('cdp_error', `selector node not in document tree: ${opts.selector}`)
    scope = found.node
    scopeSegs = found.segs
  }

  const ctx: Ctx = {
    sess,
    tab: r,
    out: [],
    chars: 0,
    emitted: 0,
    candidates: 0,
    textSeq: 0,
    refs: [],
    maxChars: opts.maxChars ?? DEFAULT_MAX_CHARS,
    maxNodes: opts.maxNodes ?? DEFAULT_MAX_NODES,
    truncated: false,
    visited: 0,
  }

  // tab.url/title 依赖 targetInfoChanged，可能滞后——用 live eval 兜底
  let title = String(r.tab.title ?? '')
  let url = String(r.tab.url ?? '')
  try {
    const live = await sess.evaluate(r, '({u:location.href,t:document.title})', { signal: opts.signal })
    const lo = (live ?? {}) as { u?: string; t?: string }
    if (typeof lo.u === 'string' && lo.u) url = lo.u
    if (typeof lo.t === 'string') title = lo.t
  } catch { /* 页面导航中——用 tab 字段 */ }
  const header = `# ${title || url}  ${url}`
  ctx.out.push(header)
  ctx.chars = header.length + 1

  // 根是 document(nodeType 9)；segs 为空，html 元素子节点自然生成 'html:nth-of-type(1)'
  visit(ctx, scope, scopeSegs, false)

  const omitted = Math.max(0, ctx.candidates - ctx.emitted)
  const text = ctx.out.join('\n')
  return {
    text,
    tabId: r.tab.targetId,
    url,
    title,
    docToken: sess.docToken(r.tab),
    refs: ctx.refs.length,
    omitted,
    truncated: ctx.truncated || omitted > 0,
    visited: ctx.visited,
  }
}

/** 查找 nodeId 并回传其完整 CSS 路径段（含自身）。 */
function findWithPath(node: DomNode, nodeId: number, segs: PathSeg[]): { node: DomNode; segs: PathSeg[] } | undefined {
  if (node.nodeId === nodeId) return { node, segs }
  const counts = new Map<string, number>()
  for (const c of node.children ?? []) {
    let childSegs = segs
    if ((c.nodeType ?? 0) === 1) {
      const ctag = tagOf(c)
      const idx = (counts.get(ctag) ?? 0) + 1
      counts.set(ctag, idx)
      childSegs = [...segs, { tag: ctag, index: idx }]
    }
    const f = findWithPath(c, nodeId, childSegs)
    if (f) return f
  }
  if (node.contentDocument) {
    const f = findWithPath(node.contentDocument, nodeId, segs)
    if (f) return f
  }
  return undefined
}
