/**
 * src/cdp/ax.ts — Accessibility.getFullAXTree → role:name 行。
 * 引擎返回真实 AX 树（design.md §9 spike）；过滤 ignored，maxNodes 截断。
 */

import type { SessionBrowser } from './session.ts'
import type { JsonObject } from './types.ts'

const DEFAULT_MAX_NODES = 300

interface AxNode {
  nodeId?: string
  role?: { value?: string }
  name?: { value?: string }
  ignored?: boolean
  childIds?: string[]
}

export interface AxOptions {
  tabId?: string
  maxNodes?: number
  signal?: AbortSignal
}

export interface AxResult {
  text: string
  nodes: number
  truncated: boolean
}

export async function axTree(sess: SessionBrowser, opts: AxOptions = {}): Promise<AxResult> {
  const r = await sess.resolveTab(opts.tabId)
  const res = await sess.cdp('Accessibility.getFullAXTree', {}, { sessionId: r.sessionId, signal: opts.signal })
  const nodes = (res.nodes ?? []) as unknown as AxNode[]
  const byId = new Map<string, AxNode>()
  for (const n of nodes) if (n.nodeId) byId.set(n.nodeId, n)

  const max = opts.maxNodes ?? DEFAULT_MAX_NODES
  const lines: string[] = []
  const seen = new Set<string>()
  let truncated = false

  const visit = (n: AxNode, depth: number): void => {
    if (truncated) return
    if (lines.length >= max) {
      truncated = true
      return
    }
    if (n.ignored) return
    const role = n.role?.value ?? ''
    const name = (n.name?.value ?? '').replace(/\s+/g, ' ').trim()
    if (role || name) {
      lines.push(`${'  '.repeat(Math.min(depth, 12))}${role}${name ? `: ${name.slice(0, 120)}` : ''}`)
    }
    for (const cid of n.childIds ?? []) {
      const c = byId.get(cid)
      if (c && !seen.has(cid)) {
        seen.add(cid)
        visit(c, depth + 1)
      }
    }
  }

  const root = nodes.find((n) => n.role?.value === 'RootWebArea') ?? nodes[0]
  if (root?.nodeId) {
    seen.add(root.nodeId)
    visit(root, 0)
  }
  // 孤儿节点兜底（childIds 链未覆盖的）
  for (const n of nodes) {
    if (truncated) break
    if (n.nodeId && !seen.has(n.nodeId) && !n.ignored) {
      seen.add(n.nodeId)
      visit(n, 0)
    }
  }

  return { text: lines.join('\n'), nodes: lines.length, truncated }
}
