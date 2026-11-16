// src/links.ts 单测：表达式生成（selector 注入安全、limit 钳制、语法有效）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLinksExpression } from '../../src/links.ts'

test('generated script parses as valid JS', () => {
  assert.doesNotThrow(() => new Function(buildLinksExpression()))
  assert.doesNotThrow(() => new Function(buildLinksExpression({ selector: 'nav a' })))
})

test('selector is JSON-escaped, not interpolated raw', () => {
  const evil = `x");alert(1);//`
  const src = buildLinksExpression({ selector: evil })
  assert.ok(src.includes(JSON.stringify(evil)))
  assert.ok(!src.includes(`querySelector(${evil})`))
})

test('limit is clamped to [1,500] and defaults to 200', () => {
  assert.ok(buildLinksExpression().includes('out.length<200'))
  assert.ok(buildLinksExpression({ limit: 0 }).includes('out.length<1'))
  assert.ok(buildLinksExpression({ limit: 9999 }).includes('out.length<500'))
  assert.ok(buildLinksExpression({ limit: 50 }).includes('out.length<50'))
})

test('no-selector scope is the whole document', () => {
  const src = buildLinksExpression()
  assert.ok(src.includes('var scope=document;'))
})

test('dedupe=base strips #fragment before dedup key', () => {
  const src = buildLinksExpression({ dedupe: 'base' })
  assert.ok(src.includes("var key=u.split('#')[0];"))
  const def = buildLinksExpression()
  assert.ok(def.includes('var key=u;'))
})
