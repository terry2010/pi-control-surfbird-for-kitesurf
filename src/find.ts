/**
 * src/find.ts — 页内查找（Ctrl+F 语义）的页面侧脚本生成器。
 *
 * Kitesurf 没有原生 find-in-page（无 window.find、无对应 CDP 域），
 * 也不依赖 CSS Custom Highlight / 选区渲染——本实现只做：
 * TreeWalker 扫文本节点计数 → Range.getClientRects 定位 → scrollTo 居中，
 * 返回命中上下文 snippet。匹配状态存 window.__surfbirdFind，
 * next/prev 复用；文档导航后 window 重建自动失效。
 */

export type FindAction = 'first' | 'next' | 'prev' | 'count' | 'clear'

export interface FindOptions {
  text: string
  action?: FindAction
  caseSensitive?: boolean
  wholeWord?: boolean
}

/** 生成可直接 Runtime.evaluate 的 IIFE 源码。 */
export function buildFindExpression(opts: FindOptions): string {
  const params = JSON.stringify({
    text: opts.text,
    action: opts.action ?? 'first',
    caseSensitive: opts.caseSensitive === true,
    wholeWord: opts.wholeWord === true,
  })
  return `(function(){
  var OPTS = ${params};
  var KEY = '__surfbirdFind';
  var st = window[KEY];

  function escRe(s){ return s.replace(/[.*+?^$\\{\\}()|[\\]\\\\]/g, '\\\\$&'); }
  var re = new RegExp(escRe(OPTS.text), 'g' + (OPTS.caseSensitive ? '' : 'i'));
  var SKIP = {SCRIPT:1, STYLE:1, NOSCRIPT:1, TEMPLATE:1, HEAD:1};
  var csCache = new Map();
  var isWord = function(c){ return /[A-Za-z0-9_]/.test(c); };

  function visible(node){
    var el = node.parentElement;
    while (el && el !== document.body){
      var tn = el.tagName;
      if (tn && SKIP[tn]) return false;
      if (el.hidden) return false;
      var cs = csCache.get(el);
      if (cs === undefined){
        try {
          var c = getComputedStyle(el);
          cs = c.display !== 'none' && c.visibility !== 'hidden' && c.visibility !== 'collapse';
        } catch(e){ cs = true; }
        csCache.set(el, cs);
      }
      if (!cs) return false;
      el = el.parentElement;
    }
    return true;
  }

  function wordOk(t, i, len){
    if (!OPTS.wholeWord) return true;
    var b = i > 0 ? t.charAt(i - 1) : '';
    var a = i + len < t.length ? t.charAt(i + len) : '';
    return !isWord(b) && !isWord(a);
  }

  function scan(){
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var out = [];
    var n, t, m, nodeMatches;
    while ((n = w.nextNode())){
      t = n.nodeValue || '';
      if (!t) continue;
      re.lastIndex = 0;
      nodeMatches = null;
      while ((m = re.exec(t))){
        if (m[0].length === 0){ re.lastIndex++; continue; }
        if (!wordOk(t, m.index, m[0].length)) continue;
        if (nodeMatches === null) nodeMatches = [];
        nodeMatches.push({node: n, offset: m.index, length: m[0].length});
      }
      if (nodeMatches && nodeMatches.length && visible(n)) out = out.concat(nodeMatches);
    }
    return out;
  }

  function snippet(mt){
    var t = mt.node.nodeValue || '';
    var s = Math.max(0, mt.offset - 80);
    var e = Math.min(t.length, mt.offset + mt.length + 80);
    return t.slice(s, e).replace(/\\s+/g, ' ').replace(/^\\s+|\\s+$/g, '');
  }

  function jump(idx){
    var mt = st.matches[idx];
    var range = document.createRange();
    range.setStart(mt.node, mt.offset);
    range.setEnd(mt.node, mt.offset + mt.length);
    var rects = range.getClientRects ? range.getClientRects() : null;
    var top = null;
    if (rects && rects.length){
      for (var i = 0; i < rects.length; i++){
        if (rects[i].height > 0){ top = rects[i].top; break; }
      }
    }
    if (top === null){
      var el = mt.node.parentElement;
      if (el && el.scrollIntoView) el.scrollIntoView({block:'center'});
    } else {
      var ih = window.innerHeight || 600;
      window.scrollTo(0, Math.max(0, window.scrollY + top - ih / 2));
    }
    st.index = idx;
    return {count: st.matches.length, index: idx, snippet: snippet(mt), scrollY: Math.round(window.scrollY)};
  }

  var sig = JSON.stringify([OPTS.text, OPTS.caseSensitive, OPTS.wholeWord]);
  var act = OPTS.action || 'first';
  var matches, index;

  if (act === 'clear'){
    var old = st ? st.matches.length : 0;
    delete window[KEY];
    return {count: old, index: -1, cleared: true};
  }
  if (act === 'count'){
    return {count: scan().length};
  }
  if (act === 'first'){
    matches = scan();
    st = {sig: sig, matches: matches, index: -1};
    window[KEY] = st;
    index = matches.length ? 0 : -1;
  } else {
    if (st && st.sig === sig && st.matches && st.matches.length){
      matches = st.matches;
      index = st.index + (act === 'next' ? 1 : -1);
      if (index >= matches.length) index = 0;
      if (index < 0) index = matches.length - 1;
      var mt0 = matches[index];
      if (mt0.node && mt0.node.isConnected === false){
        matches = scan();
        st.matches = matches;
        index = act === 'next' ? 0 : matches.length - 1;
      }
    } else {
      matches = scan();
      st = {sig: sig, matches: matches, index: -1};
      window[KEY] = st;
      index = act === 'prev' ? matches.length - 1 : 0;
    }
  }
  if (!matches.length) return {count: 0, index: -1, snippet: null, note: 'no matches'};
  return jump(index);
})()`
}
