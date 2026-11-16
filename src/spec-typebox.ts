/**
 * src/spec-typebox.ts — 工具参数 spec → TypeBox schema 投影。
 *
 * tools.ts 沿用共享 DSL（required 是 per-property 注解）；pi 的
 * registerTool 要 TypeBox TSchema——这里做一次投影：
 * - 顶层隐式 object，非 required 属性包 Type.Optional
 * - enum → Literal union，const → Literal
 * - object.additionalProperties=false；oneOf → Type.Union
 * - 'json' → Type.Unknown（任意值）
 */
import { Type, type TSchema } from 'typebox'
import type { PropertySpec, SpecMap, ValueSpec } from './schema.ts'

function annotations(spec: ValueSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (spec.description !== undefined) out.description = spec.description
  if (spec.title !== undefined) out.title = spec.title
  if (spec.default !== undefined) out.default = spec.default
  if (spec.examples !== undefined) out.examples = spec.examples
  return out
}

function literalUnion(values: readonly (string | number | boolean | null)[]): TSchema {
  return Type.Union(values.map((v) => Type.Literal(v)))
}

function valueToTypeBox(spec: ValueSpec): TSchema {
  const ann = annotations(spec)
  switch (spec.type) {
    case 'string': {
      if (spec.const !== undefined) return Type.Literal(spec.const, ann)
      if (spec.enum) return Type.Union(spec.enum.map((v) => Type.Literal(v)), ann)
      return Type.String(ann)
    }
    case 'number':
    case 'integer': {
      const base = spec.type === 'integer' ? Type.Integer : Type.Number
      if (spec.const !== undefined) return Type.Literal(spec.const, ann)
      if (spec.enum) return Type.Union(spec.enum.map((v) => Type.Literal(v)), ann)
      return base(ann)
    }
    case 'boolean': {
      if (spec.const !== undefined) return Type.Literal(spec.const, ann)
      if (spec.enum) return Type.Union(spec.enum.map((v) => Type.Literal(v)), ann)
      return Type.Boolean(ann)
    }
    case 'null':
      return Type.Null(ann)
    case 'array':
      return Type.Array(spec.items ? valueToTypeBox(spec.items) : Type.Unknown(), ann)
    case 'object': {
      const props: Record<string, TSchema> = {}
      for (const [key, ps] of Object.entries(spec.properties ?? {})) {
        props[key] = ps.required ? valueToTypeBox(ps) : Type.Optional(valueToTypeBox(ps))
      }
      return Type.Object(props, { ...ann, additionalProperties: spec.additionalProperties })
    }
    case 'json':
      return Type.Unknown(ann)
    default: {
      // oneOf（spec.type 缺省或 'oneOf'）
      const oneOf = 'oneOf' in spec ? spec.oneOf : undefined
      if (oneOf) return Type.Union(oneOf.map((s) => valueToTypeBox(s)), ann)
      return Type.Unknown(ann)
    }
  }
}

/** spec map → 顶层 Type.Object；非 required 属性 Optional。 */
export function specToTypeBox(parameters: SpecMap): TSchema {
  const props: Record<string, TSchema> = {}
  for (const [key, spec] of Object.entries(parameters)) {
    props[key] = spec.required ? valueToTypeBox(spec) : Type.Optional(valueToTypeBox(spec))
  }
  return Type.Object(props)
}
