/**
 * src/cdp/extract.ts — Readability 文章抽取 → Markdown。
 *
 * 引擎事实（design.md §5.9）：
 * - Readability.js 是 CJS UMD ~100KB，Node 侧 createRequire 加载
 * - Page.addScriptToEvaluateOnNewDocument 是 page-target 域 → 懒注入：
 *   首次 extract 时 Page.evaluate 注入源码到当前 document，之后每次
 *   extract 用 Runtime.evaluate 直接 new Readability(document).parse()
 * - Boa 的 DOM shim 支持 Readability 所需子集（surfbird proxy 同款方案）；
 *   Turndown 在 Node 侧跑（Boa DOM 不完整会挂 turndown）
 * - parse() 返回 null → no_article
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { SessionBrowser, ResolvedTab } from './session.ts'
import { SurfbirdError, type JsonObject } from './types.ts'

const req = createRequire(import.meta.url ?? fileURLToPath(import.meta.url))

let readabilitySrc: string | undefined
function loadReadability(): string {
  if (readabilitySrc === undefined) {
    // 读包入口文件源码注入页面（UMD 会 define 自身 Readability 全局）
    readabilitySrc = req('node:fs').readFileSync(req.resolve('@mozilla/readability'), 'utf8')
  }
  return readabilitySrc
}

let TurndownService: any
function turndown(): any {
  if (!TurndownService) {
    TurndownService = require('turndown')
    if (TurndownService.default) TurndownService = TurndownService.default
  }
  return new TurndownService({ headingStyle: 'atx' })
}

export interface ExtractResult {
  title: string
  byline: string
  excerpt: string
  url: string
  /** 文章 HTML（Readability content） */
  content: string
  /** Turndown 转换的 Markdown */
  markdown: string
  tabId: string
  siteName: string
}

const EXTRACT_EXPR = `(function(){
  if (typeof Readability === 'undefined') return {__err:'Readability not loaded'};
  try {
    var doc = document.cloneNode ? document.cloneNode(true) : document;
    var article = new Readability(doc).parse();
    if (!article) return {__null:true};
    return {
      title: article.title || '',
      byline: article.byline || '',
      excerpt: article.excerpt || '',
      siteName: article.siteName || '',
      content: article.content || '',
      url: article.url || (location && location.href) || ''
    };
  } catch (e) {
    return {__err: String(e && e.message || e)};
  }
})()`

/** 确保当前 document 里有 Readability 全局（每 target 每 document 懒注入一次）。 */
async function ensureReadability(sess: SessionBrowser, r: ResolvedTab, signal?: AbortSignal): Promise<void> {
  const src = loadReadability()
  if (!src) throw new SurfbirdError('cdp_error', 'Readability package not resolvable')
  const has = await sess.evaluate(r, `typeof Readability !== 'undefined'`, { signal })
  if (has === true) return
  // 注入：evaluate 整个 UMD 源文件（同步执行，~100KB 一次性成本）
  await sess.cdp('Runtime.evaluate', { expression: src, returnByValue: false }, { sessionId: r.sessionId, signal })
  const ok = await sess.evaluate(r, `typeof Readability !== 'undefined'`, { signal })
  if (ok !== true) throw new SurfbirdError('cdp_error', 'Readability injection failed in page context')
}

export async function extract(sess: SessionBrowser, opts: { tabId?: string; maxChars?: number; signal?: AbortSignal } = {}): Promise<ExtractResult> {
  const r = await sess.resolveTab(opts.tabId)
  await ensureReadability(sess, r, opts.signal)
  const res = await sess.evaluate(r, EXTRACT_EXPR, { signal: opts.signal })

  const obj = (res ?? {}) as JsonObject
  if (obj.__err) throw new SurfbirdError('cdp_error', `extract failed: ${String(obj.__err)}`)
  if (obj.__null) throw new SurfbirdError('no_article', 'no readable article found on this page')

  const content = String(obj.content ?? '')
  const md = turndown().turndown(content)
  const maxChars = opts.maxChars ?? 50_000
  const markdown = md.length > maxChars ? md.slice(0, maxChars) + '\n\n…[truncated]' : md

  return {
    title: String(obj.title ?? ''),
    byline: String(obj.byline ?? ''),
    excerpt: String(obj.excerpt ?? ''),
    url: String(obj.url ?? r.tab.url ?? ''),
    content,
    markdown,
    tabId: r.tab.targetId,
    siteName: String(obj.siteName ?? ''),
  }
}
