/**
 * src/cdp/wait.ts — wait 谓词：统一轮询（250ms），事件订阅省去——
 * readyState/location/元素状态轮询已足够，且天然兼容 setDocumentContent
 * 同步事件竞态与导航中 evaluate 抛错（pollUntil 吞错续轮）。
 *
 * 引擎事实（design.md §5.7/§8）：
 * - Page.navigate 回复不等 load → wait=load 真等 readyState==='complete'
 * - input 触发的导航异步 → click 后必须 wait
 * - 元素可见性：ref→DOM.resolveNode→Runtime.callFunctionOn 取 objectId，
 *   不走全局 JS 注册表；dom-shim 无完整 layout，visible 判定用
 *   getBoundingClientRect/offset 尺寸 + display/visibility 兜底
 */

import type { SessionBrowser, ResolvedTab } from './session.ts'
import { SurfbirdError, type JsonObject } from './types.ts'

const POLL_MS = 250
const DEFAULT_TIMEOUT_MS = 30_000
/** networkidle/stable 的"静默窗口"：无活动持续该时长才算就绪（对齐 Playwright networkidle）。 */
const IDLE_QUIET_MS = 500

export type WaitState =
  | 'load'
  | 'domcontentloaded'
  | 'url'
  | 'text'
  | 'text_gone'
  | 'visible'
  | 'hidden'
  | 'enabled'
  | 'networkidle'
  | 'stable'

export interface WaitOptions {
  tabId?: string
  state: WaitState
  url?: string
  text?: string
  target?: number // ref id（eN）
  selector?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface WaitResult {
  ok: boolean
  state: WaitState
  elapsedMs: number
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    function onAbort() {
      clearTimeout(t)
      signal?.removeEventListener('abort', onAbort)
      reject(new SurfbirdError('aborted', 'wait aborted'))
    }
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

async function pollUntil(fn: () => Promise<boolean>, intervalMs: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) throw new SurfbirdError('aborted', 'wait aborted')
    try {
      if (await fn()) return true
    } catch (e) {
      if (e instanceof SurfbirdError && (e.code === 'aborted' || e.code === 'doc_changed' || e.code === 'ref_stale')) throw e
      // 导航中 evaluate/CDP 抛错 → 继续轮询
    }
    const remain = deadline - Date.now()
    if (remain <= 0) return false
    await sleep(Math.min(intervalMs, remain), signal)
  }
}

const STATE_FN: Record<string, string> = {
  visible: 'shown',
  hidden: '!shown',
  enabled: 'enabled',
}

/** callFunctionOn 的 functionDeclaration：this=元素，returnByValue 出布尔。 */
function stateFunction(state: WaitState): string {
  return `function(){var e=this;if(!e||!e.nodeType)return false;
var cs=(typeof getComputedStyle==='function')?getComputedStyle(e):null;
var r=(typeof e.getBoundingClientRect==='function')?e.getBoundingClientRect():null;
var w=r?r.width:(e.offsetWidth||0),h=r?r.height:(e.offsetHeight||0);
var styled=cs&&(cs.display==='none'||cs.visibility==='hidden'||cs.visibility==='collapse');
var shown=(w>0&&h>0)||!!e.offsetParent;
var enabled=!e.disabled;
var __s=shown&&!styled;
return ${STATE_FN[state] === 'shown' ? '__s' : STATE_FN[state] === '!shown' ? '!__s' : 'enabled'};}`
}

async function probe(sess: SessionBrowser, r: ResolvedTab, o: WaitOptions): Promise<boolean> {
  switch (o.state) {
    case 'load':
    case 'domcontentloaded': {
      const want = o.state === 'load' ? 'complete' : null
      const v = await sess.evaluate(r, 'document.readyState', { signal: o.signal })
      if (want) return v === want
      return v === 'interactive' || v === 'complete'
    }
    case 'url': {
      const v = await sess.evaluate(r, 'location.href', { signal: o.signal })
      const href = String(v ?? '')
      return o.url ? href.includes(o.url) : href.length > 0
    }
    case 'text':
    case 'text_gone': {
      const needle = String(o.text ?? '')
      const expr = o.selector
        ? `(()=>{const e=document.querySelector(${JSON.stringify(o.selector)});return e?(e.innerText||e.textContent||''):''})()`
        : `document.body?(document.body.innerText||''):''`
      const v = await sess.evaluate(r, expr, { signal: o.signal })
      const has = String(v ?? '').includes(needle)
      return o.state === 'text' ? has : !has
    }
    case 'networkidle': {
      // 无 buffer = 未观测到任何网络事件 = 视为空闲；有挂起请求或静默窗口未满 → 继续等
      const b = sess.buffersFor(r.sessionId)?.network
      if (!b) return true
      return b.inFlightCount() === 0 && Date.now() - b.lastActivityAt >= IDLE_QUIET_MS
    }
    case 'stable': {
      // MutationObserver 静默窗口：安装观察者后 quietMs 内无 DOM 变更即就绪。
      // 导航销毁 window → 下次探测自动重装；MutationObserver 缺失时退化为 readyState。
      const quiet = IDLE_QUIET_MS
      const v = await sess.evaluate(r, `(()=>{var w=window;if(typeof MutationObserver==='undefined'||!document||!document.documentElement)return !!(document&&document.readyState==='complete');if(!w.__sbStableObs){w.__sbStableAt=Date.now();try{w.__sbStableObs=new MutationObserver(function(){w.__sbStableAt=Date.now()});w.__sbStableObs.observe(document.documentElement,{childList:true,subtree:true,attributes:true,characterData:true})}catch(e){w.__sbStableObs=null;return document.readyState==='complete'}}return Date.now()-(w.__sbStableAt||0)>=${quiet}})()`, { signal: o.signal })
      return v === true
    }
    case 'visible':
    case 'hidden':
    case 'enabled': {
      if (o.target !== undefined) {
        const nodeId = await sess.resolveRef(o.target, r.tab)
        const rn = await sess.cdp('DOM.resolveNode', { nodeId }, { sessionId: r.sessionId, signal: o.signal })
        const obj = (rn.object ?? {}) as JsonObject
        const objectId = typeof obj.objectId === 'string' ? obj.objectId : undefined
        if (!objectId) return false
        const res = await sess.cdp('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: stateFunction(o.state),
          returnByValue: true,
        }, { sessionId: r.sessionId, signal: o.signal })
        return ((res.result as JsonObject | undefined)?.value) === true
      }
      if (o.selector) {
        const expr = `(()=>{const e=document.querySelector(${JSON.stringify(o.selector)});if(!e)return false;return (function(){var e=this;var cs=(typeof getComputedStyle==='function')?getComputedStyle(e):null;var r=(typeof e.getBoundingClientRect==='function')?e.getBoundingClientRect():null;var w=r?r.width:(e.offsetWidth||0),h=r?r.height:(e.offsetHeight||0);var styled=cs&&(cs.display==='none'||cs.visibility==='hidden'||cs.visibility==='collapse');var shown=(w>0&&h>0)||!!e.offsetParent;var enabled=!e.disabled;var __s=shown&&!styled;return ${STATE_FN[o.state] === 'shown' ? '__s' : STATE_FN[o.state] === '!shown' ? '!__s' : 'enabled'};}).call(e)})()`
        const v = await sess.evaluate(r, expr, { signal: o.signal })
        return v === true
      }
      throw new SurfbirdError('cdp_error', `${o.state} wait requires ref (target) or selector`)
    }
  }
}

export async function waitFor(sess: SessionBrowser, o: WaitOptions): Promise<WaitResult> {
  const start = Date.now()
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const r = await sess.resolveTab(o.tabId)
  const ok = await pollUntil(() => probe(sess, r, o), POLL_MS, timeoutMs, o.signal)
  const elapsedMs = Date.now() - start
  if (ok) return { ok: true, state: o.state, elapsedMs }
  const hint = o.state === 'visible' || o.state === 'enabled'
    ? ' (element may be hidden/disabled, or selector/ref is wrong)'
    : ''
  throw new SurfbirdError('timeout', `wait ${o.state} timed out after ${timeoutMs}ms${hint}`, { retryable: true })
}
