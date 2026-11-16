// Live smoke: real Kitesurf engine over SSH tunnel.
// env: SURFBIRD_URL=http://127.0.0.1:18080 SURFBIRD_TOKEN=your-token
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionBrowser } from '../../src/cdp/session.ts'
import { snapshot } from '../../src/cdp/snapshot.ts'
import { waitFor } from '../../src/cdp/wait.ts'
import { click, fill, elementRect } from '../../src/cdp/input.ts'
import { buildLinksExpression } from '../../src/links.ts'

const URL = process.env.SURFBIRD_URL ?? process.env.KITESURF_URL
const TOKEN = process.env.SURFBIRD_TOKEN ?? process.env.KITESURF_TOKEN
const opts = { endpoint: URL, token: TOKEN, requestTimeoutMs: 30000, keepaliveMs: 0 }

test('live smoke: connect→navigate→snapshot→evaluate→screenshot', { timeout: 120000 }, async (t) => {
  if (!URL) return t.skip('SURFBIRD_URL not set')
  const sess = new SessionBrowser('smoke', opts)
  t.after(() => sess.disconnect())

  // status/connect
  const tabs = await sess.listTabs()
  assert.ok(Array.isArray(tabs), 'listTabs')

  // new tab + navigate example.com
  const tab = await sess.newTab('https://example.com')
  assert.ok(tab.targetId, 'newTab targetId')
  await waitFor(sess, { state: 'load', timeoutMs: 30000 })

  // evaluate
  const title = await sess.evaluate(await sess.resolveTab(), 'document.title')
  assert.match(String(title), /Example/i)

  // snapshot（example.com 的标题是 SVG 不是 h1——只断言标题/链接/文本）
  const snap = await snapshot(sess, {})
  assert.match(snap.text, /# Example Domain\s+https:\/\/example\.com/)
  assert.match(snap.text, /\[e\d+\] link "Learn more"/)
  assert.ok(snap.refs >= 1, `refs=${snap.refs}`)
  assert.ok(snap.docToken.includes('#'))

  // navigate to a form page via setDocumentContent (hermetic)
  const r = await sess.resolveTab()
  await sess.cdp('Page.setDocumentContent', {
    frameId: (await sess.cdp('Page.getFrameTree', {}, { sessionId: r.sessionId })).frameTree.frame.id,
    html: `<!doctype html><html><body><h1>Test Form</h1><input id="q" type="text" placeholder="Search"><button id="b">Go</button><a href="/next">Next</a><script>window.__clicked=0;document.getElementById('b').onclick=()=>{window.__clicked++;document.title='Clicked'}</script></body></html>`,
  }, { sessionId: r.sessionId })
  await waitFor(sess, { state: 'load', timeoutMs: 10000 })

  const snap2 = await snapshot(sess, {})
  assert.match(snap2.text, /Test Form/)
  assert.match(snap2.text, /\[e\d+\] button "Go"/)
  assert.match(snap2.text, /\[e\d+\] link "Next"/)
  assert.match(snap2.text, /textbox "Search"/)

  // fill + click + verify（refs 是计数；eN 从 text 正则取）
  const btnId = Number(/\[e(\d+)\] button "Go"/.exec(snap2.text)?.[1])
  const inId = Number(/\[e(\d+)\] textbox "Search"/.exec(snap2.text)?.[1])
  assert.ok(btnId > 0 && inId > 0, `refs btn=${btnId} in=${inId}`)

  const fr = await sess.resolveTab()
  const fillRes = await fill(sess, fr, { ref: inId }, 'hello surfbird')
  assert.equal(fillRes.changed, true, `fill: ${JSON.stringify(fillRes)}`)

  await click(sess, fr, { ref: btnId })
  await waitFor(sess, { state: 'url', url: 'example.com', timeoutMs: 5000 }).catch(() => undefined)
  await new Promise((r2) => setTimeout(r2, 800))
  const clicked = await sess.evaluate(fr, 'window.__clicked')
  assert.equal(clicked, 1, `__clicked=${clicked}`)

  // console capture
  await sess.evaluate(fr, 'console.log("smoke-marker-123")')
  await new Promise((r2) => setTimeout(r2, 300))
  const buf = sess.buffersFor(fr.sessionId)
  const con = buf?.console.read({})
  assert.ok(con?.entries.some((e) => e.text.includes('smoke-marker-123')), 'console captured')

  // screenshot
  const shot = await sess.cdp('Page.captureScreenshot', { format: 'png' }, { sessionId: fr.sessionId })
  assert.ok(typeof shot.data === 'string' && shot.data.length > 1000, 'screenshot data')
  assert.equal(shot.error, undefined, `screenshot error: ${shot.error}`)

  // pdf
  const pdf = await sess.cdp('Page.printToPDF', {}, { sessionId: fr.sessionId })
  assert.ok(typeof pdf.data === 'string' && pdf.data.length > 100, 'pdf data')
  assert.equal(pdf.error, undefined, `pdf error: ${pdf.error}`)

  // pdf 全参数（paperWidth/preferCSSPageSize/margins/omitBackground）
  const pdf2 = await sess.cdp('Page.printToPDF', {
    paperWidth: 5, paperHeight: 7, landscape: true, preferCSSPageSize: false,
    marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4,
    printBackground: true, omitBackground: false,
  }, { sessionId: fr.sessionId })
  assert.ok(typeof pdf2.data === 'string' && pdf2.data.length > 100, 'pdf2 data')
  assert.equal(pdf2.error, undefined, `pdf2 error: ${pdf2.error}`)

  // fullPage 序列（tools.ts screenshot() 同款）：getLayoutMetrics → resize → capture → restore
  const metrics = await sess.cdp('Page.getLayoutMetrics', {}, { sessionId: fr.sessionId })
  const cs = metrics.cssContentSize ?? metrics.contentSize
  const lv = metrics.cssLayoutViewport ?? metrics.layoutViewport
  assert.ok(cs?.width > 0 && cs?.height > 0, `contentSize ${JSON.stringify(cs)}`)
  const clampW = Math.min(2560, Math.floor(cs.width))
  const clampH = Math.min(2560, Math.floor(cs.height))
  await sess.cdp('Emulation.setDeviceMetricsOverride',
    { width: clampW, height: clampH, deviceScaleFactor: 1, mobile: false }, { sessionId: fr.sessionId })
  try {
    const shotFull = await sess.cdp('Page.captureScreenshot', { format: 'png' }, { sessionId: fr.sessionId })
    assert.ok(typeof shotFull.data === 'string' && shotFull.data.length > 1000, 'fullPage data')
    assert.equal(shotFull.error, undefined, `fullPage error: ${shotFull.error}`)
  } finally {
    await sess.cdp('Emulation.setDeviceMetricsOverride',
      { width: lv.clientWidth, height: lv.clientHeight, deviceScaleFactor: 1, mobile: false },
      { sessionId: fr.sessionId })
  }

  // clip
  const shotClip = await sess.cdp('Page.captureScreenshot',
    { format: 'png', clip: { x: 0, y: 0, width: 200, height: 200 } }, { sessionId: fr.sessionId })
  assert.ok(typeof shotClip.data === 'string' && shotClip.data.length > 100, 'clip data')
  assert.equal(shotClip.error, undefined, `clip error: ${shotClip.error}`)

  // elementRect：form 页 button#b 的文档坐标包围盒（screenshot target 同源路径）
  const btnDoc = await sess.cdp('DOM.getDocument', { depth: -1 }, { sessionId: fr.sessionId })
  const btnQ = await sess.cdp('DOM.querySelector',
    { nodeId: (btnDoc.root ?? {}).nodeId, selector: '#b' }, { sessionId: fr.sessionId })
  assert.ok(btnQ.nodeId > 0, 'button#b nodeId')
  const rect = await elementRect(sess, fr, Number(btnQ.nodeId))
  assert.ok(rect.width > 0 && rect.height > 0, `elementRect ${JSON.stringify(rect)}`)

  // links 表达式（smoke 页有 /next 链接）
  const linksVal = await sess.evaluate(fr, buildLinksExpression(), { returnByValue: true })
  assert.ok(Array.isArray(linksVal?.links), 'links shape')
  assert.ok(linksVal.links.some((l) => String(l.url).includes('/next')), `links: ${JSON.stringify(linksVal).slice(0, 200)}`)

  // page-settle waits：页面已 settled，两者应快速返回
  const t0 = Date.now()
  await waitFor(sess, { state: 'networkidle', timeoutMs: 10000 })
  await waitFor(sess, { state: 'stable', timeoutMs: 10000 })
  assert.ok(Date.now() - t0 < 10000, 'networkidle+stable resolved')

  // WebMCP：注入 registerTool → toolsAdded → invoke → toolResponded
  await sess.evaluate(fr, `document.modelContext.registerTool({
    name:'smokeEcho', description:'echo args back',
    inputSchema:{type:'object',properties:{msg:{type:'string'}}},
    execute: async (args)=>({content:[{type:'text',text:'echo:'+JSON.stringify(args)}]})
  })`, { awaitPromise: true })
  const tools = await sess.webmcpList(fr)
  const echo = tools.find((t) => t.name === 'smokeEcho')
  assert.ok(echo, `webmcp tools: ${tools.map((t) => t.name).join(',')}`)
  const inv = await sess.webmcpInvoke(fr, 'smokeEcho', { msg: 'hi' }, { timeoutMs: 15000 })
  assert.equal(inv.status, 'Completed', `invoke: ${JSON.stringify(inv)}`)
  const outText = JSON.stringify(inv.output ?? '')
  assert.ok(outText.includes('echo:'), `output: ${outText.slice(0, 200)}`)
  // 未知工具 → cdp_error
  await assert.rejects(() => sess.webmcpInvoke(fr, 'noSuchTool', {}, { timeoutMs: 5000 }), /unknown WebMCP tool/)

  console.log('SMOKE OK — tabs:', tabs.length, 'refs:', snap2.refs, 'fullPage:', `${clampW}x${clampH}`, 'webmcp:', tools.length)
})
