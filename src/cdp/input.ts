/**
 * src/cdp/input.ts — 元素定位 + 鼠标/键盘/滚动原语。
 *
 * 引擎事实（design.md §8/§9）：
 * - getContentQuads 返回 {quads:[]} 不抛错；scrollIntoViewIfNeeded 抛 "Node is
 *   detached"；判定链：scrollIntoView→getContentQuads→describeNode
 * - Input.* 吞错恒回 {} → 交互后建议 wait 验证（工具层负责提示）
 * - mouseReleased 自动补发 click/auxclick/contextmenu/dblclick → 不合成
 * - Kitesurf.setControlValue(nodeId,value)→{changed,value,error} 原生 fill
 * - nodeId===backendNodeId；DOM.resolveNode→objectId→callFunctionOn 取元素
 */

import type { SessionBrowser, ResolvedTab } from './session.ts'
import { SurfbirdError, type Json, type JsonObject } from './types.ts'

export interface Target {
  ref?: number
  selector?: string
  x?: number
  y?: number
}

export interface Point {
  x: number
  y: number
}

function assertTarget(t: Target): void {
  const kinds = [t.ref !== undefined, !!t.selector, t.x !== undefined && t.y !== undefined].filter(Boolean).length
  if (kinds !== 1) throw new SurfbirdError('cdp_error', 'provide exactly one of ref / selector / x+y')
}

/** 目标 → nodeId（ref/selector）；坐标目标返回 undefined。 */
export async function resolveNodeId(sess: SessionBrowser, r: ResolvedTab, t: Target, signal?: AbortSignal): Promise<number | undefined> {
  assertTarget(t)
  if (t.x !== undefined && t.y !== undefined) return undefined
  if (t.ref !== undefined) {
    return sess.resolveRef(t.ref, r.tab)
  }
  const doc = await sess.cdp('DOM.getDocument', { depth: -1 }, { sessionId: r.sessionId, signal })
  const rootId = Number(((doc.root ?? {}) as JsonObject).nodeId ?? 0)
  const q = await sess.cdp('DOM.querySelector', { nodeId: rootId, selector: t.selector }, { sessionId: r.sessionId, signal })
  const nodeId = Number(q.nodeId ?? 0)
  if (!nodeId) throw new SurfbirdError('cdp_error', `selector matched nothing: ${t.selector}`)
  return nodeId
}

/** nodeId → 中心点。detached→ref_stale；空 quads→element_not_visible。 */
export async function elementCenter(sess: SessionBrowser, r: ResolvedTab, nodeId: number, signal?: AbortSignal): Promise<Point> {
  try {
    await sess.cdp('DOM.scrollIntoViewIfNeeded', { nodeId }, { sessionId: r.sessionId, signal })
  } catch (e) {
    if (e instanceof SurfbirdError) {
      const msg = e.message.toLowerCase()
      if (msg.includes('detach') || msg.includes('not found') || msg.includes('no node')) {
        throw new SurfbirdError('ref_stale', `element is detached from the document — re-run surfbird_snapshot`)
      }
    }
    throw e
  }
  const q = await sess.cdp('DOM.getContentQuads', { nodeId }, { sessionId: r.sessionId, signal })
  const quads = (q.quads ?? []) as number[][]
  const quad = quads.find((qq) => Array.isArray(qq) && qq.length >= 8) ?? quads[0]
  if (!quad || quad.length < 8) {
    // 空 quads：区分"不可见"与"节点已死"
    try {
      const d = await sess.cdp('DOM.describeNode', { nodeId }, { sessionId: r.sessionId, signal })
      const node = (d.node ?? {}) as JsonObject
      if (!node.nodeName) throw new SurfbirdError('ref_stale', 'element no longer exists — re-run surfbird_snapshot')
    } catch (e) {
      if (e instanceof SurfbirdError && e.code === 'ref_stale') throw e
      throw new SurfbirdError('ref_stale', 'element no longer exists — re-run surfbird_snapshot')
    }
    throw new SurfbirdError('element_not_visible', 'element has no visible box (hidden, zero-size, or not laid out)')
  }
  // 四边形中心：取四角均值（前两点即可近似中心，取全部 8 值均值更稳）
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]]
  return {
    x: Math.round((xs[0] + xs[1] + xs[2] + xs[3]) / 4),
    y: Math.round((ys[0] + ys[1] + ys[2] + ys[3]) / 4),
  }
}

/** 统一入口：Target → 屏幕坐标。 */
export async function pointFor(sess: SessionBrowser, r: ResolvedTab, t: Target, signal?: AbortSignal): Promise<Point> {
  if (t.x !== undefined && t.y !== undefined) return { x: t.x, y: t.y }
  const nodeId = await resolveNodeId(sess, r, t, signal)
  if (nodeId === undefined) throw new SurfbirdError('cdp_error', 'unreachable')
  return elementCenter(sess, r, nodeId, signal)
}

async function mouse(sess: SessionBrowser, r: ResolvedTab, type: string, p: Point, opts: { button?: string; buttons?: number; clickCount?: number; signal?: AbortSignal } = {}): Promise<void> {
  await sess.cdp('Input.dispatchMouseEvent', {
    type,
    x: p.x,
    y: p.y,
    button: opts.button ?? 'left',
    buttons: opts.buttons ?? (type === 'mouseReleased' ? 0 : 1),
    clickCount: opts.clickCount ?? 1,
  }, { sessionId: r.sessionId, signal: opts.signal })
}

export async function click(sess: SessionBrowser, r: ResolvedTab, t: Target, opts: { double?: boolean; signal?: AbortSignal } = {}): Promise<{ x: number; y: number }> {
  const p = await pointFor(sess, r, t, opts.signal)
  const count = opts.double ? 2 : 1
  await mouse(sess, r, 'mousePressed', p, { clickCount: count, signal: opts.signal })
  await mouse(sess, r, 'mouseReleased', p, { clickCount: count, signal: opts.signal })
  return p
}

export async function hover(sess: SessionBrowser, r: ResolvedTab, t: Target, signal?: AbortSignal): Promise<Point> {
  const p = await pointFor(sess, r, t, signal)
  await mouse(sess, r, 'mouseMoved', p, { buttons: 0, signal })
  return p
}

/** nodeId → RemoteObject.objectId（callFunctionOn 用）。 */
async function objectIdOf(sess: SessionBrowser, r: ResolvedTab, nodeId: number, signal?: AbortSignal): Promise<string | undefined> {
  const rn = await sess.cdp('DOM.resolveNode', { nodeId }, { sessionId: r.sessionId, signal })
  const obj = (rn.object ?? {}) as JsonObject
  return typeof obj.objectId === 'string' ? obj.objectId : undefined
}

async function callOnElement(sess: SessionBrowser, r: ResolvedTab, objectId: string, fn: string, args: Json[] = [], signal?: AbortSignal): Promise<Json> {
  const res = await sess.cdp('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fn,
    arguments: args.map((v) => ({ value: v })),
    returnByValue: true,
  }, { sessionId: r.sessionId, signal })
  return ((res.result as JsonObject | undefined)?.value as Json | undefined) ?? null
}

/** fill：Kitesurf.setControlValue 优先；失败回退 focus+清空+.value 赋值+input/change 事件。 */
export async function fill(sess: SessionBrowser, r: ResolvedTab, t: Target, value: string, signal?: AbortSignal): Promise<{ method: string; changed: boolean; error?: string }> {
  const nodeId = await resolveNodeId(sess, r, t, signal)
  if (nodeId === undefined) throw new SurfbirdError('cdp_error', 'fill requires ref or selector (coordinates unsupported)')

  // 先滚动到可视区域保证 hit-test/焦点正确
  try {
    await sess.cdp('DOM.scrollIntoViewIfNeeded', { nodeId }, { sessionId: r.sessionId, signal })
  } catch {
    /* 元素可能已 detached——由后续调用报真实错误 */
  }

  // targetId 必须显式带上——Kitesurf.* 是 browser 级方法，缺省会落到 firstPageTarget，
  // 多 tab 时可能命中错误 target（"no PageScript" 或改错页面的元素）。
  const res = await sess.cdp('Kitesurf.setControlValue', { nodeId, value, targetId: r.tab.targetId }, { sessionId: r.sessionId, signal })
  const changed = res.changed === true
  const err = typeof res.error === 'string' ? res.error : undefined
  if (changed && !err) {
    // setControlValue 只改底层 value，不派发事件——React/Vue 受控组件感知不到。
    // 先经原生 prototype setter 重设值（绕过框架在实例上的 value tracker），再补发 input/change。
    const objectId = await objectIdOf(sess, r, nodeId, signal)
    if (objectId) {
      await callOnElement(sess, r, objectId, `function(){
        var e=this;
        try{
          var p=null;
          if(e.tagName==='INPUT'&&window.HTMLInputElement)p=window.HTMLInputElement;
          else if(e.tagName==='TEXTAREA'&&window.HTMLTextAreaElement)p=window.HTMLTextAreaElement;
          var d=p&&Object.getOwnPropertyDescriptor(p.prototype,'value');
          if(d&&d.set)d.set.call(e,e.value);
        }catch(_){}
        try{e.dispatchEvent(new Event('input',{bubbles:true}));}catch(_){}
        try{e.dispatchEvent(new Event('change',{bubbles:true}));}catch(_){}
        return true;
      }`, [], signal).catch(() => { /* 事件补发失败不影响 fill 结果 */ })
    }
    return { method: 'setControlValue', changed: true }
  }

  // fallback：objectId 路径
  const objectId = await objectIdOf(sess, r, nodeId, signal)
  if (!objectId) return { method: 'setControlValue', changed: false, error: err ?? 'element not resolvable' }
  const out = await callOnElement(sess, r, objectId, `function(v){
    var e=this;
    try{if(e.focus)e.focus();}catch(_){}
    try{if(e.select)e.select();}catch(_){}
    try{e.value=v;}catch(_){}
    try{if(e.isContentEditable!==undefined&&e.isContentEditable){e.textContent=v;}}catch(_){}
    try{e.dispatchEvent(new Event('input',{bubbles:true}));}catch(_){}
    try{e.dispatchEvent(new Event('change',{bubbles:true}));}catch(_){}
    return {value:e.value,tag:e.tagName};
  }`, [value], signal)
  const ok = typeof out === 'object' && out !== null
  return { method: 'dom', changed: ok, error: ok ? undefined : (err ?? 'fallback failed') }
}

/** nodeId → 文档坐标包围盒（captureScreenshot clip 用——rect 是视口相对，+scroll 得文档绝对坐标）。 */
export async function elementRect(sess: SessionBrowser, r: ResolvedTab, nodeId: number, signal?: AbortSignal): Promise<{ x: number; y: number; width: number; height: number }> {
  const objectId = await objectIdOf(sess, r, nodeId, signal)
  if (!objectId) throw new SurfbirdError('ref_stale', 'element not resolvable — re-run surfbird_snapshot')
  const out = await callOnElement(sess, r, objectId, `function(){
    var e=this,r=e.getBoundingClientRect();
    var sx=(typeof window.scrollX==='number')?window.scrollX:(window.pageXOffset||0);
    var sy=(typeof window.scrollY==='number')?window.scrollY:(window.pageYOffset||0);
    return {x:r.left+sx,y:r.top+sy,width:r.width,height:r.height};
  }`, [], signal)
  const o = (typeof out === 'object' && out !== null ? out : {}) as Record<string, unknown>
  const x = Number(o.x), y = Number(o.y), w = Number(o.width), h = Number(o.height)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new SurfbirdError('element_not_visible', 'element has no visible box (hidden, zero-size, or not laid out)')
  }
  return { x, y, width: w, height: h }
}

/** type：聚焦元素后 insertText（不触发 keydown——Boa KeyboardEvent 不完整）。 */
export async function typeText(sess: SessionBrowser, r: ResolvedTab, t: Target, text: string, signal?: AbortSignal): Promise<void> {
  const nodeId = await resolveNodeId(sess, r, t, signal)
  if (nodeId !== undefined) {
    try {
      await sess.cdp('DOM.scrollIntoViewIfNeeded', { nodeId }, { sessionId: r.sessionId, signal })
    } catch { /* ignore */ }
    const objectId = await objectIdOf(sess, r, nodeId, signal)
    if (objectId) {
      await callOnElement(sess, r, objectId, `function(){try{if(this.focus)this.focus();}catch(_){}try{if(this.select)this.select();}catch(_){}return true}`, [], signal)
    }
  }
  await sess.cdp('Input.insertText', { text }, { sessionId: r.sessionId, signal })
}

// ---------- press_key keymap（~60 键） ----------

interface KeyDef {
  key: string
  code: string
  vk: number
  text?: string
}

const KEYMAP: Record<string, KeyDef> = {}
function def(keys: string[], k: KeyDef): void {
  for (const name of keys) KEYMAP[name.toLowerCase()] = k
}

// 字母
def(['a'], { key: 'a', code: 'KeyA', vk: 65, text: 'a' })
// 其余字母批量生成（text=小写字母）
for (const [i, ch] of 'abcdefghijklmnopqrstuvwxyz'.split('').entries()) {
  if (ch === 'a') continue
  KEYMAP[ch] = { key: ch, code: `Key${ch.toUpperCase()}`, vk: 65 + i, text: ch }
}
// 数字行
def(['0'], { key: '0', code: 'Digit0', vk: 48, text: '0' })
for (const [i, ch] of '123456789'.split('').entries()) {
  KEYMAP[ch] = { key: ch, code: `Digit${ch}`, vk: 49 + i, text: ch }
}
// 功能/控制键
def(['enter', 'return'], { key: 'Enter', code: 'Enter', vk: 13, text: '\r' })
def(['tab'], { key: 'Tab', code: 'Tab', vk: 9 })
def(['escape', 'esc'], { key: 'Escape', code: 'Escape', vk: 27 })
def(['backspace', 'bksp'], { key: 'Backspace', code: 'Backspace', vk: 8 })
def(['delete', 'del'], { key: 'Delete', code: 'Delete', vk: 46 })
def(['space', 'spacebar'], { key: ' ', code: 'Space', vk: 32, text: ' ' })
def(['arrowup', 'up'], { key: 'ArrowUp', code: 'ArrowUp', vk: 38 })
def(['arrowdown', 'down'], { key: 'ArrowDown', code: 'ArrowDown', vk: 40 })
def(['arrowleft', 'left'], { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 })
def(['arrowright', 'right'], { key: 'ArrowRight', code: 'ArrowRight', vk: 39 })
def(['home'], { key: 'Home', code: 'Home', vk: 36 })
def(['end'], { key: 'End', code: 'End', vk: 35 })
def(['pageup'], { key: 'PageUp', code: 'PageUp', vk: 33 })
def(['pagedown'], { key: 'PageDown', code: 'PageDown', vk: 34 })
def(['insert', 'ins'], { key: 'Insert', code: 'Insert', vk: 45 })
// 修饰键
def(['shift'], { key: 'Shift', code: 'ShiftLeft', vk: 16 })
def(['control', 'ctrl'], { key: 'Control', code: 'ControlLeft', vk: 17 })
def(['alt'], { key: 'Alt', code: 'AltLeft', vk: 18 })
def(['meta', 'cmd', 'command'], { key: 'Meta', code: 'MetaLeft', vk: 91 })
def(['capslock'], { key: 'CapsLock', code: 'CapsLock', vk: 20 })
// F1-F12
def(['f1'], { key: 'F1', code: 'F1', vk: 112 })
def(['f2'], { key: 'F2', code: 'F2', vk: 113 })
def(['f3'], { key: 'F3', code: 'F3', vk: 114 })
def(['f4'], { key: 'F4', code: 'F4', vk: 115 })
def(['f5'], { key: 'F5', code: 'F5', vk: 116 })
def(['f6'], { key: 'F6', code: 'F6', vk: 117 })
def(['f7'], { key: 'F7', code: 'F7', vk: 118 })
def(['f8'], { key: 'F8', code: 'F8', vk: 119 })
def(['f9'], { key: 'F9', code: 'F9', vk: 120 })
def(['f10'], { key: 'F10', code: 'F10', vk: 121 })
def(['f11'], { key: 'F11', code: 'F11', vk: 122 })
def(['f12'], { key: 'F12', code: 'F12', vk: 123 })
// 标点
def(['-', 'minus'], { key: '-', code: 'Minus', vk: 189, text: '-' })
def(['=', 'equals'], { key: '=', code: 'Equal', vk: 187, text: '=' })
def(['[', 'bracketleft'], { key: '[', code: 'BracketLeft', vk: 219, text: '[' })
def([']', 'bracketright'], { key: ']', code: 'BracketRight', vk: 221, text: ']' })
def([';', 'semicolon'], { key: ';', code: 'Semicolon', vk: 186, text: ';' })
def(["'", 'quote'], { key: "'", code: 'Quote', vk: 222, text: "'" })
def(['`', 'backquote'], { key: '`', code: 'Backquote', vk: 192, text: '`' })
def([',', 'comma'], { key: ',', code: 'Comma', vk: 188, text: ',' })
def(['.', 'period'], { key: '.', code: 'Period', vk: 190, text: '.' })
def(['/', 'slash'], { key: '/', code: 'Slash', vk: 191, text: '/' })
def(['\\', 'backslash'], { key: '\\', code: 'Backslash', vk: 220, text: '\\' })
// 导航键别名
def(['pgup'], KEYMAP['pageup'])
def(['pgdn'], KEYMAP['pagedown'])

export function lookupKey(name: string): KeyDef | undefined {
  return KEYMAP[name.toLowerCase()] ?? KEYMAP[name]
}

export async function pressKey(sess: SessionBrowser, r: ResolvedTab, key: string, opts: { modifiers?: number; signal?: AbortSignal } = {}): Promise<void> {
  const k = lookupKey(key)
  if (!k) throw new SurfbirdError('cdp_error', `unknown key: ${key} (see surfbird_press_key docs for supported keys)`)
  const mods = opts.modifiers ?? 0
  const base = {
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.vk,
    nativeVirtualKeyCode: k.vk,
    modifiers: mods,
  }
  // 有 text 的键发 keyDown+char；控制键发 rawKeyDown+keyUp
  if (k.text !== undefined) {
    await sess.cdp('Input.dispatchKeyEvent', { ...base, type: 'keyDown', text: k.text, unmodifiedText: k.text }, { sessionId: r.sessionId, signal: opts.signal })
  } else {
    await sess.cdp('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' }, { sessionId: r.sessionId, signal: opts.signal })
  }
  await sess.cdp('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, { sessionId: r.sessionId, signal: opts.signal })
}

/** scroll：delta 滚轮 或 target/selector 滚动到视野。 */
export async function scroll(sess: SessionBrowser, r: ResolvedTab, opts: { deltaX?: number; deltaY?: number; target?: Target; signal?: AbortSignal } = {}): Promise<{ scrolled: 'wheel' | 'intoView' }> {
  if (opts.target) {
    const nodeId = await resolveNodeId(sess, r, opts.target, opts.signal)
    if (nodeId === undefined) throw new SurfbirdError('cdp_error', 'scroll target requires ref or selector')
    await sess.cdp('DOM.scrollIntoViewIfNeeded', { nodeId }, { sessionId: r.sessionId, signal: opts.signal })
    return { scrolled: 'intoView' }
  }
  const dx = opts.deltaX ?? 0
  const dy = opts.deltaY ?? 600
  // 视口中心作为滚轮锚点
  const p = { x: 400, y: 300 }
  try {
    const vp = await sess.cdp('Page.getLayoutMetrics', {}, { sessionId: r.sessionId, signal: opts.signal })
    const layout = (vp.layoutViewport ?? {}) as JsonObject
    if (typeof layout.clientWidth === 'number' && typeof layout.clientHeight === 'number') {
      p.x = Math.round(layout.clientWidth / 2)
      p.y = Math.round(layout.clientHeight / 2)
    }
  } catch { /* 用默认锚点 */ }
  await sess.cdp('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: p.x,
    y: p.y,
    deltaX: dx,
    deltaY: dy,
  }, { sessionId: r.sessionId, signal: opts.signal })
  return { scrolled: 'wheel' }
}
