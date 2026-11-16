// Unit tests — no live engine. node --test test/unit/*.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEndpoint } from '../../src/cdp/transport.ts'
import { SessionRegistry, SessionBrowser } from '../../src/cdp/session.ts'
import { lookupKey } from '../../src/cdp/input.ts'
import { ConsoleBuffer, NetworkBuffer } from '../../src/cdp/events.ts'
import { snapshot } from '../../src/cdp/snapshot.ts'
import { resolveConfig } from '../../src/config.ts'

// ---------- normalizeEndpoint ----------

test('normalizeEndpoint: http base → ws devtools/browser', () => {
  assert.equal(normalizeEndpoint('http://127.0.0.1:8080'), 'ws://127.0.0.1:8080/devtools/browser')
  assert.equal(normalizeEndpoint('https://example.com:8443'), 'wss://example.com:8443/devtools/browser')
  assert.equal(normalizeEndpoint('ws://h:1/devtools/browser'), 'ws://h:1/devtools/browser')
  assert.equal(normalizeEndpoint('wss://h/devtools/browser'), 'wss://h/devtools/browser')
})

// ---------- resolveConfig ----------

test('resolveConfig: env fallback + token precedence + default endpoint env override', () => {
  const saved = { ...process.env }
  try {
    delete process.env.SURFBIRD_URL; delete process.env.SURFBIRD_ENDPOINT
    delete process.env.KITESURF_URL; delete process.env.KITESURF_ENDPOINT
    delete process.env.SURFBIRD_TOKEN; delete process.env.KITESURF_TOKEN

    // 默认值
    let c = resolveConfig({})
    assert.equal(c.endpoint, 'http://127.0.0.1:8080')
    assert.equal(c.token, '')
    assert.equal(c.configSource, 'default+none')

    // env endpoint 覆盖 schemastery 默认值
    process.env.SURFBIRD_URL = 'http://10.0.0.1:9999'
    c = resolveConfig({})
    assert.equal(c.endpoint, 'http://10.0.0.1:9999')
    assert.equal(c.configSource, 'env+none')

    // config endpoint 优先于 env
    c = resolveConfig({ endpoint: 'http://cfg:1' })
    assert.equal(c.endpoint, 'http://cfg:1')
    assert.equal(c.configSource, 'options+none')

    // token：env < config < tokenFile
    process.env.SURFBIRD_TOKEN = 'envtok'
    c = resolveConfig({})
    assert.equal(c.token, 'envtok')
    c = resolveConfig({ token: 'cfgtok' })
    assert.equal(c.token, 'cfgtok')
    c = resolveConfig({ token: 'cfgtok', tokenFile: '/nonexistent' })
    assert.equal(c.token, 'cfgtok') // 文件不存在 → 回退
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
})

// ---------- keymap ----------

test('lookupKey: common keys + aliases + unknown', () => {
  assert.equal(lookupKey('enter').key, 'Enter')
  assert.equal(lookupKey('Return').key, 'Enter')
  assert.equal(lookupKey('a').text, 'a')
  assert.equal(lookupKey('Z').text, 'z') // 小写归一化
  assert.equal(lookupKey('arrowdown').code, 'ArrowDown')
  assert.equal(lookupKey('f5').vk, 116)
  assert.equal(lookupKey('escape').vk, 27)
  assert.equal(lookupKey('ctrl').key, 'Control') // 'ctrl' 是 'control' 的别名
  assert.equal(lookupKey('nonexistent'), undefined)
})

// ---------- SessionRegistry ----------

test('SessionRegistry: get/create/touch/release/disposeAll', async () => {
  const reg = new SessionRegistry({ maxSessions: 2, idleEvictMs: 60000 })
  const a = reg.get('s1', {})
  const b = reg.get('s2', {})
  assert.equal(reg.get('s1', {}), a) // 同 key 复用
  assert.equal(reg.size(), 2)
  await reg.release('s1')
  assert.equal(reg.size(), 1)
  await reg.disposeAll()
  assert.equal(reg.size(), 0)
  void b
})

test('SessionRegistry: too_many_sessions 无 idle 可驱逐', () => {
  const reg = new SessionRegistry({ maxSessions: 1, idleEvictMs: 60000 })
  reg.get('a', {})
  assert.throws(() => reg.get('b', {}), (e) => e?.code === 'too_many_sessions')
})

test('SessionRegistry: 驱逐 idle session', async () => {
  const reg = new SessionRegistry({ maxSessions: 1, idleEvictMs: 1 })
  const a = reg.get('old', {})
  a.lastUsed = Date.now() - 10000 // 手动老化
  const b = reg.get('new', {})
  assert.notEqual(a, b)
  assert.equal(reg.size(), 1)
  await reg.disposeAll()
})

// ---------- buffers ----------

test('ConsoleBuffer: seq 游标 + only=errors + clear', () => {
  const buf = new ConsoleBuffer(3)
  buf.push('log', 'hello')
  buf.push('error', 'boom')
  buf.push('warn', 'careful')
  buf.push('error', 'bang') // cap=3 → 最早的 log 被挤出
  const all = buf.read({})
  assert.equal(all.entries.length, 3)
  assert.equal(all.nextSince, 4)
  const errs = buf.read({ only: 'errors' })
  assert.deepEqual(errs.entries.map((e) => e.type), ['error', 'error'])
  const inc = buf.read({ since: all.nextSince })
  assert.equal(inc.entries.length, 0)
  buf.clear()
  assert.equal(buf.size, 0)
})

test('NetworkBuffer: 聚合 + sinceIndex + sessionIdOf', () => {
  const buf = new NetworkBuffer(10)
  buf.onRequestWillBeSent('S1', { requestId: 'r1', request: { url: 'http://a/', method: 'GET' } })
  buf.onResponseReceived({ requestId: 'r1', response: { status: 200, mimeType: 'text/html' } })
  buf.onLoadingFinished({ requestId: 'r1', encodedDataLength: 1234 })
  buf.onRequestWillBeSent('S1', { requestId: 'r2', request: { url: 'http://b/', method: 'POST' } })
  buf.onLoadingFailed({ requestId: 'r2', errorText: 'net::ERR' })
  assert.equal(buf.sessionIdOf('r1'), 'S1')
  const res = buf.read({})
  assert.equal(res.entries.length, 2)
  assert.equal(res.entries[0].status, 200)
  assert.equal(res.entries[0].size, 1234)
  assert.equal(res.entries[1].failed, true)
  const inc = buf.read({ sinceIndex: res.nextIndex })
  assert.equal(inc.entries.length, 0)
})

test('NetworkBuffer: inFlightCount + lastActivityAt（networkidle 判定）', () => {
  const buf = new NetworkBuffer(10)
  assert.equal(buf.inFlightCount(), 0)
  const t0 = buf.lastActivityAt
  buf.onRequestWillBeSent('S1', { requestId: 'r1', request: { url: 'http://a/', method: 'GET' } })
  assert.equal(buf.inFlightCount(), 1)
  assert.ok(buf.lastActivityAt > t0)
  buf.onRequestWillBeSent('S1', { requestId: 'r2', request: { url: 'http://b/', method: 'GET' } })
  assert.equal(buf.inFlightCount(), 2)
  buf.onLoadingFinished({ requestId: 'r1' })
  assert.equal(buf.inFlightCount(), 1)
  buf.onLoadingFailed({ requestId: 'r2', errorText: 'net::ERR' })
  assert.equal(buf.inFlightCount(), 0)
})

// ---------- snapshot digest（fake sess，无引擎） ----------

function el(nodeId, tag, attrsObj = {}, children = [], nodeName) {
  const attributes = []
  for (const [k, v] of Object.entries(attrsObj)) attributes.push(k, v)
  return { nodeId, nodeType: 1, nodeName: nodeName ?? tag.toUpperCase(), localName: tag, attributes, children }
}
function txt(nodeId, text) {
  return { nodeId, nodeType: 3, nodeName: '#text', nodeValue: text, children: [] }
}
function doc(children) {
  return { nodeId: 1, nodeType: 9, nodeName: '#document', children }
}

function fakeSess(root) {
  const refs = []
  return {
    refs,
    async resolveTab() {
      return { tab: { targetId: 'T1', url: 'http://x/', title: 'T', sessionId: 'S1' }, sessionId: 'S1' }
    },
    async cdp(method) {
      if (method === 'DOM.getDocument') return { root }
      if (method === 'DOM.querySelector') return { nodeId: 0 }
      throw new Error(`unexpected ${method}`)
    },
    async evaluate() { return { u: 'http://x/', t: 'Live Title' } },
    peekRefId() { return refs.length + 1 },
    mintRef(tab, nodeId, selector) {
      const ref = { id: refs.length + 1, tabId: tab.targetId, nodeId, docToken: 'T1#0', selector }
      refs.push(ref)
      return ref
    },
    docToken() { return 'T1#0' },
  }
}

test('snapshot: 语义 digest + eN refs + live header', async () => {
  const root = doc([
    el(2, 'html', {}, [
      el(3, 'head', {}, [el(4, 'title', {}, [txt(5, 'Doc Title')])]),
      el(6, 'body', {}, [
        el(7, 'h1', {}, [txt(8, 'Hello World')]),
        el(9, 'p', {}, [txt(10, 'Some paragraph text here.')]),
        el(11, 'a', { href: 'http://x/next' }, [txt(12, 'Next Page')]),
        el(13, 'button', {}, [txt(14, 'Submit')]),
        el(15, 'input', { type: 'text', placeholder: 'Search' }),
        el(16, 'script', {}, [txt(17, 'evil()')]),
        el(18, 'div', {}, [
          el(19, 'span', {}, [txt(20, 'nested span text')]),
          el(21, 'button', { 'aria-label': 'Close' }),
        ]),
      ]),
    ]),
  ])
  const sess = fakeSess(root)
  const res = await snapshot(sess, {})
  assert.match(res.text, /^# Live Title\s+http:\/\/x\//)
  assert.match(res.text, /\[h1\] Hello World/)
  assert.match(res.text, /\[e\d+\] link "Next Page" → http:\/\/x\/next/)
  assert.match(res.text, /\[e\d+\] button "Submit"/)
  assert.match(res.text, /\[e\d+\] textbox "Search"/)
  assert.match(res.text, /\[e\d+\] button "Close"/)
  assert.match(res.text, /\[t\d+\] Some paragraph text here/)
  assert.doesNotMatch(res.text, /evil\(\)/) // script 跳过
  assert.doesNotMatch(res.text, /Doc Title/) // head/title 跳过
  assert.equal(res.refs, 4)
  assert.ok(res.docToken === 'T1#0')
  // ref 携带 selector 兜底
  assert.ok(sess.refs.every((r) => typeof r.selector === 'string' && r.selector.includes('nth-of-type')))
})

test('snapshot: 预算截断报 omitted', async () => {
  const kids = []
  for (let i = 0; i < 20; i++) kids.push(el(100 + i, 'button', {}, [txt(200 + i, `Btn ${i}`)]))
  const root = doc([el(2, 'html', {}, [el(3, 'body', {}, kids)])])
  const sess = fakeSess(root)
  const res = await snapshot(sess, { maxNodes: 5 })
  assert.equal(res.refs, 5)
  assert.ok(res.omitted > 0)
  assert.equal(res.truncated, true)
})
