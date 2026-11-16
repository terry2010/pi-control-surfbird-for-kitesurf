/**
 * src/links.ts — surfbird_links 的页内链接提取表达式。
 *
 * 与 find.ts 同构：生成器纯函数便于单测；在页内跑 querySelectorAll('a[href]')，
 * href 已是绝对 URL（a.href 解析后），textContent 压缩空白截断。
 * 默认按 url 去重（导航栏重复链接只留一条）；scope 用 selector 子树。
 */

export interface LinksOptions {
  /** CSS selector 限定范围（在该子树内找 a[href]；缺省=整个文档）。 */
  selector?: string
  /** 返回条数上限（默认 200，引擎侧也截断）。 */
  limit?: number
  /** 去重粒度：'url' 按完整 href 含 hash（默认）；'base' 先剥 #fragment 再去重。 */
  dedupe?: 'url' | 'base'
}

const MAX_LIMIT = 500

export function buildLinksExpression(opts: LinksOptions = {}): string {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(opts.limit ?? 200)))
  const dedupeBase = opts.dedupe === 'base'
  const scopeExpr = opts.selector
    ? `(document.querySelector(${JSON.stringify(opts.selector)})||null)`
    : 'document'
  return `(function(){
  var scope=${scopeExpr};
  if(!scope)return{error:'selector matched nothing: '+${JSON.stringify(opts.selector ?? '')},links:[],total:0};
  var root=scope===document?document.documentElement:scope;
  var els=[];
  try{els=[].slice.call(root.querySelectorAll('a[href]'));}catch(_){els=[];}
  if(root.tagName==='A'&&root.href)els.unshift(root);
  var out=[],seen={},total=els.length;
  for(var i=0;i<els.length&&out.length<${limit};i++){
    var a=els[i],u='';
    try{u=a.href||'';}catch(_){continue;}
    var key=${dedupeBase ? "u.split('#')[0]" : 'u'};
    if(!key||seen[key])continue;
    seen[key]=1;
    var t='';
    try{t=(a.textContent||'').replace(/\\s+/g,' ').trim();}catch(_){}
    out.push({url:u,text:t.slice(0,160)});
  }
  return{links:out,total:total,returned:out.length,truncated:total>out.length};
})()`
}
