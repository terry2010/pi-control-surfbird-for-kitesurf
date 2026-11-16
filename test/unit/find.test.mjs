// src/find.ts 单测：表达式生成（注入安全、参数映射）。
// 页内行为靠 test/live 或真机验证——这里不测 DOM。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFindExpression } from '../../src/find.ts'

test('injects params as JSON safely', () => {
  const src = buildFindExpression({ text: 'a"b\\c${x}', action: 'first' })
  const line = src.split('\n').find((l) => l.includes('var OPTS'))
  assert.ok(line)
  const opts = JSON.parse(line.trim().replace(/^var OPTS = /, '').replace(/;$/, ''))
  assert.equal(opts.text, 'a"b\\c${x}')
  assert.equal(opts.action, 'first')
  assert.equal(opts.caseSensitive, false)
  assert.equal(opts.wholeWord, false)
})

test('defaults and flags map correctly', () => {
  const src = buildFindExpression({ text: 'x', caseSensitive: true, wholeWord: true })
  assert.ok(src.includes('"caseSensitive":true'))
  assert.ok(src.includes('"wholeWord":true'))
  assert.ok(src.includes('"action":"first"'))
})

test('generated script parses as valid JS', () => {
  for (const action of ['first', 'next', 'prev', 'count', 'clear']) {
    const src = buildFindExpression({ text: 'hit', action })
    assert.doesNotThrow(() => new Function(src), `action=${action}`)
  }
})

test('regex metacharacters are escaped for page-side RegExp', () => {
  const src = buildFindExpression({ text: 'a.b*c+d' })
  // escRe 行必须存在且含标准转义字符集
  assert.ok(/escRe\(s\)\{ return s\.replace\(\/\[\.\*\+\?\^\$/.test(src))
})
