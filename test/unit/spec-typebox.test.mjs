// spec→TypeBox 投影测试：28 个工具的 parameters spec → TSchema。
// 重点：嵌套对象 required 透出（screenshot clip x/y/width/height）、
// 顶层 required 收集（TypeBox 自动把非 Optional 属性收进 required 数组）、
// enum → literal union、oneOf → Union。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerSurfbirdTools } from '../../src/tools.ts'
import { specToTypeBox } from '../../src/spec-typebox.ts'

function collectTools() {
  const added = []
  const pi = {
    registerTool: (def) => added.push(def),
    on: () => {},
    registerCommand: () => {},
  }
  registerSurfbirdTools(pi, {
    registry: { get: () => { throw new Error('no engine in unit test') } },
    sessionOpts: () => ({}),
    requestTimeoutMs: 1000,
    outputDir: '/tmp',
  })
  return added
}

test('all 28 surfbird_* tools register with TypeBox object schemas', () => {
  const tools = collectTools()
  assert.equal(tools.length, 28)
  for (const t of tools) {
    assert.ok(t.name.startsWith('surfbird_'), t.name)
    assert.equal(t.parameters.type, 'object', t.name)
    assert.ok(t.parameters.properties && typeof t.parameters.properties === 'object', t.name)
    assert.equal(typeof t.execute, 'function', t.name)
  }
})

test('nested object required: screenshot clip requires x/y/width/height', () => {
  const tools = collectTools()
  const shot = tools.find((t) => t.name === 'surfbird_screenshot')
  const clip = shot.parameters.properties.clip
  assert.equal(clip.type, 'object')
  assert.deepEqual([...clip.required].sort(), ['height', 'width', 'x', 'y'])
  // clip 本身可选——顶层 required 不含 clip
  assert.ok(!(shot.parameters.required ?? []).includes('clip'))
})

test('top-level required collection: click requires target', () => {
  const tools = collectTools()
  const click = tools.find((t) => t.name === 'surfbird_click')
  assert.ok((click.parameters.required ?? []).includes('target'))
})

test('enum preserved as literal union: wait state', () => {
  const tools = collectTools()
  const wait = tools.find((t) => t.name === 'surfbird_wait')
  const state = wait.parameters.properties.state
  const variants = (state.anyOf ?? state.oneOf ?? []).map((s) => s.const)
  assert.ok(variants.includes('load') && variants.includes('networkidle'), JSON.stringify(state))
})

test('oneOf preserved: surfbird_evaluate expression/function', () => {
  const tools = collectTools()
  const ev = tools.find((t) => t.name === 'surfbird_evaluate')
  const expr = ev.parameters.properties.expression ?? ev.parameters.properties.function
  assert.ok(expr, 'evaluate should have a code param')
})

test('specToTypeBox: optional wraps, required collected, json → unknown', () => {
  const schema = specToTypeBox({
    req: { type: 'string', required: true },
    opt: { type: 'number' },
    any: { type: 'json' },
    en: { type: 'string', enum: ['a', 'b'] },
  })
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['req'])
  const enVariants = (schema.properties.en.anyOf ?? []).map((s) => s.const)
  assert.deepEqual(enVariants, ['a', 'b'])
})
