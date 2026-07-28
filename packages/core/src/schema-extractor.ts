/**
 * Reads field metadata out of a JSON Schema (draft 2020-12) as emitted by
 * Standard Schema libraries (zod, arktype).
 *
 * Everything here is deliberately lenient: form data is edited in place, so the
 * value at a path is routinely `null`, partially filled or invalid, and a schema
 * that can't be navigated degrades to `{}` instead of throwing. `$ref`, `allOf`,
 * `if`/`then`, `not` and `patternProperties` are not navigated — a path through
 * one of them yields `{}`.
 */
import type { JSONSchema } from 'json-schema-typed'
import type { SchemaMeta } from './types'
import { parsePath } from 'dot-prop'

type Schema = JSONSchema.Interface

/**
 * JSON Schema keyword -> `SchemaMeta` key. Array bounds are reported as length
 * bounds: to a form field, both answer "how many".
 */
const META_KEYS = {
  title: 'title',
  description: 'description',
  default: 'default',
  examples: 'examples',
  minimum: 'minimum',
  exclusiveMinimum: 'exclusiveMinimum',
  maximum: 'maximum',
  exclusiveMaximum: 'exclusiveMaximum',
  minLength: 'minLength',
  maxLength: 'maxLength',
  minItems: 'minLength',
  maxItems: 'maxLength',
} as const satisfies Partial<Record<keyof Schema, keyof SchemaMeta>>

function annotations(schema: Schema): SchemaMeta {
  const meta: Record<string, unknown> = {}
  for (const [keyword, key] of Object.entries(META_KEYS)) {
    const value = schema[keyword as keyof Schema]
    if (value !== undefined) meta[key] = value
  }
  return meta as SchemaMeta
}

// boolean schemas (`true`/`false`) carry no metadata for us
function asSchema(schema: JSONSchema | undefined): Schema | undefined {
  return typeof schema === 'object' && schema !== null ? schema : undefined
}

function branches(schema: Schema): Schema[] | undefined {
  const union = (schema.oneOf ?? schema.anyOf)?.map(asSchema).filter((s) => s !== undefined)
  return union?.length ? union : undefined
}

// json-schema-typed types `prefixItems` as a schema *or* a list of schemas; only
// the list is valid 2020-12
function prefixItems(schema: Schema): readonly (JSONSchema | undefined)[] {
  return Array.isArray(schema.prefixItems) ? schema.prefixItems : []
}

function types(schema: Schema): string[] {
  const type = schema.type
  if (type === undefined) return []
  // json-schema-typed types `type` through a generic helper that computes extra
  // non-string members; a real `type` is always a string or an array of strings.
  return (Array.isArray(type) ? type : [type]) as string[]
}

function isNull(schema: Schema): boolean {
  return types(schema).length === 1 && types(schema)[0] === 'null'
}

/**
 * A bare `{type: 'null'}` branch is how a nullable field is encoded, so it makes
 * the field optional. One carrying annotations is a union member the schema
 * author described on purpose — that one is a value like any other.
 */
function isNullableSugar(schema: Schema): boolean {
  return isNull(schema) && Object.keys(annotations(schema)).length === 0
}

function typeMatches(schema: Schema, value: unknown): boolean {
  const expected = types(schema)
  if (expected.length === 0) return true // untyped: matches anything

  return expected.some((type) => {
    switch (type) {
      case 'array': {
        return Array.isArray(value)
      }
      case 'boolean': {
        return typeof value === 'boolean'
      }
      case 'integer': {
        // dates serialize as {type: 'integer', format: 'epoch'}, but the
        // in-memory form value is still a Date
        return Number.isInteger(value) || (schema.format === 'epoch' && value instanceof Date)
      }
      case 'null': {
        return value === null
      }
      case 'number': {
        return typeof value === 'number'
      }
      case 'object': {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
      }
      case 'string': {
        return typeof value === 'string'
      }
      default: {
        return false
      }
    }
  })
}

/** Numbers and dates are bounded by their value, strings and arrays by their length. */
function measure(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' || Array.isArray(value)) return value.length
  return undefined
}

function boundsMatch(schema: Schema, value: unknown): boolean {
  const n = measure(value)
  if (n === undefined) return true

  // each keyword only exists on the type it belongs to, so folding them is safe
  const min = schema.minimum ?? schema.minLength ?? schema.minItems
  const max = schema.maximum ?? schema.maxLength ?? schema.maxItems

  return (
    (min === undefined || n >= min) &&
    (max === undefined || n <= max) &&
    (schema.exclusiveMinimum === undefined || n > schema.exclusiveMinimum) &&
    (schema.exclusiveMaximum === undefined || n < schema.exclusiveMaximum)
  )
}

/**
 * Does `value` fit `schema`? Used to pick a union branch, so it only asks what a
 * half-filled form can answer: anything not entered yet (`null`/`undefined`)
 * fits, and a nested value is judged by its type and `const`/`enum` alone — a
 * nested bound may legitimately be unmet while the user is still typing.
 */
function matches(schema: Schema, value: unknown, nested = false): boolean {
  const union = branches(schema)
  if (union) return union.some((branch) => matches(branch, value, nested))

  if (value === null || value === undefined) return true
  if (!typeMatches(schema, value)) return false
  if ('const' in schema && schema.const !== value) return false
  if (schema.enum && !schema.enum.includes(value)) return false
  if (!nested && !boundsMatch(schema, value)) return false

  if (schema.properties && typeof value === 'object' && !Array.isArray(value))
    return Object.entries(schema.properties).every(([key, property]) => {
      const child = asSchema(property)
      return !child || matches(child, (value as Record<string, unknown>)[key], true)
    })

  if (Array.isArray(value))
    return prefixItems(schema).every((item, index) => {
      const child = asSchema(item)
      return !child || matches(child, value[index], true)
    })

  return true
}

type Resolved = {
  schema: Schema
  meta: SchemaMeta
  /** the schema encodes a nullable value, which this library treats as optional */
  nullable: boolean
}

/** Leaf of the first-branch chain — the fallback when the value points at no branch. */
function firstLeaf(schema: Schema): Schema {
  for (let union = branches(schema); union; union = branches(schema)) schema = union[0]!
  return schema
}

/**
 * Descend into the union branch that fits `value`, inheriting annotations on the
 * way down (the deeper branch wins). When no branch matches — the usual case for
 * an empty field — the first branch is used and its leaf's annotations fill
 * whatever the enclosing schemas left unset.
 */
function resolve(root: Schema, value: unknown): Resolved {
  const empty = value === null || value === undefined
  let schema = root
  let meta = annotations(schema)
  let nullable = false
  let matched = true

  for (let union = branches(schema); union; union = branches(schema)) {
    nullable ||= union.some(isNullableSugar)

    const match = empty ? union.find(isNull) : union.find((branch) => matches(branch, value))
    matched &&= !empty && match !== undefined

    schema = match ?? union[0]!
    meta = { ...meta, ...annotations(schema) }
  }

  if (!matched) meta = { ...annotations(firstLeaf(root)), ...meta }

  return { schema, meta, nullable }
}

function isArray(schema: Schema): boolean {
  return types(schema).includes('array') || schema.items !== undefined
}

function child(schema: Schema, segment: string | number): Schema | undefined {
  // a numeric segment indexes an array (`list[0]`), but dot-prop parses a numeric
  // property name to a number too (`rec.0`), so both shapes have to be tried
  const item =
    typeof segment === 'number'
      ? // tuple positions first, then the rest-element schema
        (asSchema(prefixItems(schema)[segment]) ?? asSchema(schema.items))
      : undefined

  // `additionalProperties` is the value schema of a record
  return item ?? asSchema(schema.properties?.[segment]) ?? asSchema(schema.additionalProperties)
}

type Location = {
  schema: Schema
  /** enclosing schema, union-resolved, `undefined` at the root */
  parent: Schema | undefined
  key: string | number | undefined
  value: unknown
}

function walk(root: Schema, data: unknown, segments: (string | number)[]): Location | undefined {
  let schema = root
  let parent: Schema | undefined
  let key: string | number | undefined
  let value = data

  for (const segment of segments) {
    parent = resolve(schema, value).schema
    key = segment

    const next = child(parent, key)
    if (!next) return undefined

    schema = next
    value =
      typeof value === 'object' && value !== null
        ? (value as Record<string | number, unknown>)[key]
        : undefined
  }

  return { schema, parent, key, value }
}

export function getSchemaMeta(jsonSchema: Schema, data: object, path: string): SchemaMeta {
  // dot-prop parses the root path to [''] instead of []
  const location = walk(jsonSchema, data, path ? parsePath(path) : [])
  if (!location) return {}

  const { parent, key } = location
  const { meta, nullable } = resolve(location.schema, location.value)

  const required =
    parent === undefined || key === undefined || isArray(parent)
      ? // the root and array elements exist as soon as their container does
        !nullable
      : !!parent.required?.includes(String(key)) && !nullable

  return { ...meta, required }
}
