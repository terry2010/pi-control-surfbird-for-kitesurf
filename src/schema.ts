/**
 * src/schema.ts — 工具参数 spec → JSON Schema 转换。
 *
 * tools.ts 沿用 DSH 版的作者侧 spec 写法（required 是 per-property 注解），
 * OpenCode 的 ToolInfo.input 要标准 JSON Schema——这里做一次投影：
 * 顶层隐式 object，required 收集为数组，additionalProperties=false。
 */

export interface SpecAnnotations {
  description?: string
  title?: string
  default?: unknown
  examples?: unknown
}

export interface StringSpec extends SpecAnnotations { type: 'string'; enum?: readonly string[]; const?: string }
export interface NumberSpec extends SpecAnnotations { type: 'number'; enum?: readonly number[]; const?: number }
export interface IntegerSpec extends SpecAnnotations { type: 'integer'; enum?: readonly number[]; const?: number }
export interface BooleanSpec extends SpecAnnotations { type: 'boolean'; enum?: readonly boolean[]; const?: boolean }
export interface NullSpec extends SpecAnnotations { type: 'null'; enum?: readonly null[]; const?: null }
export interface ArraySpec extends SpecAnnotations { type: 'array'; items?: ValueSpec }
export interface ObjectSpec extends SpecAnnotations { type: 'object'; properties?: SpecMap; additionalProperties: boolean }
export interface JsonSpec extends SpecAnnotations { type: 'json' }
export interface OneOfSpec extends SpecAnnotations { type?: 'oneOf'; oneOf: readonly [ValueSpec, ValueSpec, ...ValueSpec[]] }

export type ValueSpec = StringSpec | NumberSpec | IntegerSpec | BooleanSpec | NullSpec | ArraySpec | ObjectSpec | JsonSpec | OneOfSpec
export type PropertySpec = ValueSpec & { required?: true }
export type SpecMap = Record<string, PropertySpec>

function valueToJsonSchema(spec: ValueSpec): Record<string, unknown> {
  const base: Record<string, unknown> = {}
  if (spec.description !== undefined) base.description = spec.description
  if (spec.title !== undefined) base.title = spec.title
  if (spec.default !== undefined) base.default = spec.default
  if (spec.examples !== undefined) base.examples = spec.examples
  switch (spec.type) {
    case 'string': {
      base.type = 'string'
      if (spec.enum) base.enum = [...spec.enum]
      if (spec.const !== undefined) base.const = spec.const
      return base
    }
    case 'number': {
      base.type = 'number'
      if (spec.enum) base.enum = [...spec.enum]
      if (spec.const !== undefined) base.const = spec.const
      return base
    }
    case 'integer': {
      base.type = 'integer'
      if (spec.enum) base.enum = [...spec.enum]
      if (spec.const !== undefined) base.const = spec.const
      return base
    }
    case 'boolean': {
      base.type = 'boolean'
      if (spec.enum) base.enum = [...spec.enum]
      if (spec.const !== undefined) base.const = spec.const
      return base
    }
    case 'null': {
      base.type = 'null'
      if (spec.enum) base.enum = [...spec.enum]
      if (spec.const !== undefined) base.const = spec.const
      return base
    }
    case 'array':
      base.type = 'array'
      base.items = spec.items ? valueToJsonSchema(spec.items) : {}
      return base
    case 'object': {
      base.type = 'object'
      if (spec.properties) {
        const nested = mapToJsonSchema(spec.properties)
        base.properties = nested.properties
        // 嵌套对象的 required 同样要透出（如 screenshot clip 的 x/y/width/height）
        if (nested.required.length) base.required = nested.required
      }
      base.additionalProperties = spec.additionalProperties
      return base
    }
    case 'json':
      // 无约束 JSON 值——只带注解，模型按 description 理解
      return base
    default: {
      if ('oneOf' in spec && Array.isArray(spec.oneOf)) base.oneOf = spec.oneOf.map(valueToJsonSchema)
      return base
    }
  }
}

export function mapToJsonSchema(spec: SpecMap): { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false } {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, prop] of Object.entries(spec)) {
    properties[key] = valueToJsonSchema(prop)
    if (prop.required === true) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}
