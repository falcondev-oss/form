import type { JSONSchema7, JSONSchema7Definition, JSONSchema7TypeName } from 'json-schema'
import type { SchemaMeta } from './types'
import { debugLog } from './util'

const META_KEYS = [
  'title',
  'description',
  'default',
  'examples',
  'minimum',
  'exclusiveMinimum',
  'maximum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
] as const satisfies readonly (keyof SchemaMeta)[]

const UNSUPPORTED_KEYS = [
  '$ref',
  'allOf',
  'if',
  'then',
  'else',
  'not',
  'patternProperties',
] as const

// Module-level dedup for the one-time warning. Exposed so a CI test can assert that
// the real schemas never hit an unsupported construct (and reset between suites).
export const unsupportedConstructs = new Set<string>()
export function resetUnsupportedConstructs() {
  unsupportedConstructs.clear()
}
function onUnsupported(construct: string, path: string) {
  if (unsupportedConstructs.has(construct)) return
  unsupportedConstructs.add(construct)
  debugLog(() => [
    `useForm: schema navigator hit unsupported JSON Schema construct '${construct}' at path '${path}' — field metadata degraded to {}`,
  ])
}
function scanUnsupported(node: Schema, path: string) {
  let found = false
  for (const k of UNSUPPORTED_KEYS) {
    if (node[k as keyof Schema] !== undefined) {
      found = true
      onUnsupported(k, path)
    }
  }
  return found
}

type Schema = JSONSchema7

function asSchema(s: JSONSchema7Definition | undefined): Schema | undefined {
  // boolean schemas (`true`/`false`) and absent schemas carry no metadata for us
  return typeof s === 'object' && s !== null ? s : undefined
}

function typeNames(schema: Schema): JSONSchema7TypeName[] {
  if (!schema.type) return []
  return Array.isArray(schema.type) ? schema.type : [schema.type]
}

function isNullBranch(schema: Schema): boolean {
  const t = typeNames(schema)
  return t.length === 1 && t[0] === 'null'
}

function typeMatchesValue(schema: Schema, value: unknown): boolean {
  const types = typeNames(schema)
  if (types.length === 0) return true // untyped branch matches anything
  return types.some((t) => {
    switch (t) {
      case 'null': {
        return value === null
      }
      case 'string': {
        return typeof value === 'string'
      }
      case 'boolean': {
        return typeof value === 'boolean'
      }
      case 'integer': {
        // dates are configured to serialize as {type:'integer', format:'epoch'};
        // the in-memory value may still be a Date, so accept both.
        return (
          (typeof value === 'number' && Number.isInteger(value)) ||
          (schema.format === 'epoch' && value instanceof Date)
        )
      }
      case 'number': {
        return typeof value === 'number'
      }
      case 'array': {
        return Array.isArray(value)
      }
      case 'object': {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
      }
      default: {
        return false
      }
    }
  })
}

function unionBranches(schema: Schema): Schema[] | undefined {
  const of = schema.oneOf ?? schema.anyOf
  if (!of) return undefined
  return of.map(asSchema).filter((s): s is Schema => !!s)
}

function branchLiteralMatches(branch: Schema, value: unknown): boolean {
  if ('const' in branch) return branch.const === value
  if (Array.isArray(branch.enum)) return (branch.enum as unknown[]).includes(value)
  return false
}

// Discriminated-object union: the branch whose const/enum *properties* all agree with
// the value. Requires ≥1 such property so a const-free branch can't win vacuously.
function matchDiscriminatedBranch(
  branches: Schema[],
  value: Record<string, unknown>,
): Schema | undefined {
  return branches.find((b) => {
    if (!b.properties) return false
    const discriminators = Object.entries(b.properties)
      .map(([k, p]) => [k, asSchema(p)] as const)
      .filter(([, p]) => p && ('const' in p || Array.isArray(p.enum)))
    if (discriminators.length === 0) return false
    return discriminators.every(([k, p]) =>
      'const' in p! ? value[k] === p.const : (p!.enum as unknown[]).includes(value[k]),
    )
  })
}

function resolveOneUnion(
  branches: Schema[],
  value: unknown,
): { branch: Schema | undefined; nullable: boolean } {
  const nullable = branches.some(isNullBranch)

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const discriminated = matchDiscriminatedBranch(branches, value as Record<string, unknown>)
    if (discriminated) return { branch: discriminated, nullable }
  } else if (value !== null && value !== undefined) {
    const literal = branches.find((b) => branchLiteralMatches(b, value))
    if (literal) return { branch: literal, nullable }
  }

  // type union (dominant case: nullable leaf). Prefer the non-null branch matching
  // the value's type; else the first non-null branch, so constraints still surface
  // when the value is currently null/absent.
  // Ceiling: an undiscriminated union of the SAME base type (e.g. two `string`
  // branches with different constraints) can't be disambiguated by type — we take
  // the first matching branch. The old library couldn't resolve these either; such
  // schemas don't occur in the zod/arktype output we target.
  const nonNull = branches.filter((b) => !isNullBranch(b))
  const byType =
    value !== null && value !== undefined
      ? nonNull.find((b) => typeMatchesValue(b, value))
      : undefined
  return { branch: byType ?? nonNull[0], nullable }
}

// Resolve nested unions until the node is no longer a union.
function resolveUnionsDeep(
  node: Schema,
  value: unknown,
): { node: Schema; nullable: boolean; wrapper: Schema | undefined } {
  let nullable = typeNames(node).includes('null')
  let wrapper: Schema | undefined
  let branches = unionBranches(node)
  while (branches) {
    wrapper ??= node
    const r = resolveOneUnion(branches, value)
    nullable ||= r.nullable
    if (!r.branch) break
    node = r.branch
    nullable ||= typeNames(node).includes('null')
    branches = unionBranches(node)
  }
  return { node, nullable, wrapper }
}

function pickAnnotations(schema: Schema): SchemaMeta {
  const out: Record<string, unknown> = {}
  for (const key of META_KEYS) {
    if (schema[key] !== undefined) out[key] = schema[key]
  }
  return out
}

// Union-level annotations (e.g. a `.describe()` that zod v4 places on the `anyOf`
// wrapper of a nullable field) flow onto the resolved branch; inner-branch keys win.
function mergeSharedAnnotations(wrapper: Schema | undefined, branch: Schema): Schema {
  if (!wrapper) return branch
  const shared: Record<string, unknown> = {}
  for (const key of META_KEYS) {
    if (wrapper[key] !== undefined && branch[key] === undefined) shared[key] = wrapper[key]
  }
  return Object.keys(shared).length > 0 ? { ...branch, ...shared } : branch
}

type Segment = { key: string; isIndex: boolean }

function parsePath(path: string): Segment[] {
  const segments: Segment[] = []
  let key = ''
  for (let i = 0; i < path.length; i++) {
    if (path[i] === '\\' && path[i + 1] === '.') {
      key += '.'
      i++
    } else if (path[i] === '.') {
      if (key) segments.push({ key, isIndex: false })
      key = ''
    } else if (path[i] === '[') {
      const end = path.indexOf(']', i)
      const index = path.slice(i + 1, end)
      if (end > i && /^\d+$/.test(index)) {
        if (key) segments.push({ key, isIndex: false })
        segments.push({ key: index, isIndex: true })
        key = ''
        i = end
      } else {
        key += path[i]
      }
    } else {
      key += path[i]
    }
  }
  if (key) segments.push({ key, isIndex: false })
  return segments
}

function childSchema(node: Schema, seg: Segment, path: string): Schema | undefined {
  if (scanUnsupported(node, path)) return

  if (seg.isIndex) {
    const i = Number(seg.key)
    // tuple prefix (prefixItems = 2020-12; array `items` = draft-07), then the rest
    // element (single `items` in 2020-12, `additionalItems` in draft-07).
    const prefix = (node as { prefixItems?: JSONSchema7Definition[] }).prefixItems
    if (Array.isArray(prefix) && prefix[i] !== undefined) return asSchema(prefix[i])
    if (Array.isArray(node.items)) {
      return asSchema(
        node.items[i] ?? (node as { additionalItems?: JSONSchema7Definition }).additionalItems,
      )
    }
    return asSchema(node.items)
  }

  const prop = asSchema(node.properties?.[seg.key])
  if (prop) return prop
  // records: additionalProperties schema
  return asSchema(
    typeof node.additionalProperties === 'object' ? node.additionalProperties : undefined,
  )
}

function walk(root: Schema, segments: Segment[], data: unknown, path: string) {
  let node: Schema = root
  let parent: Schema | undefined
  let curValue: unknown = data

  for (const seg of segments) {
    if (scanUnsupported(node, path)) return
    node = resolveUnionsDeep(node, curValue).node

    parent = node
    const next = childSchema(node, seg, path)
    if (!next) return
    node = next

    curValue =
      curValue !== null && typeof curValue === 'object'
        ? (curValue as Record<string, unknown>)[seg.key]
        : undefined
  }

  return { node, parent, value: curValue }
}

export function getSchemaMeta(jsonSchema: JSONSchema7, data: object, path: string): SchemaMeta {
  const segments = parsePath(path)
  const walked = walk(jsonSchema, segments, data, path)
  if (!walked) return {}

  const { parent } = walked
  if (scanUnsupported(walked.node, path)) return {}
  const { node, nullable, wrapper } = resolveUnionsDeep(walked.node, walked.value)
  if (scanUnsupported(node, path)) return {}
  const meta = pickAnnotations(mergeSharedAnnotations(wrapper, node))

  const lastSeg = segments.at(-1)
  if (!parent || !lastSeg) {
    meta.required = true
  } else if (lastSeg.isIndex) {
    meta.required = false
  } else {
    const req = Array.isArray(parent.required) ? parent.required : []
    meta.required = req.includes(lastSeg.key) && !nullable
  }

  return meta
}
