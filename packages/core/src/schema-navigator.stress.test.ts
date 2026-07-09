import type { JSONSchema7 } from 'json-schema'
import { type } from 'arktype'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  getSchemaMeta,
  resetUnsupportedConstructs,
  unsupportedConstructs,
} from './schema-navigator'
import { genJsonSchema } from './schema-navigator.fixtures'

// A deliberately messy, generically-named form-builder union that exercises the hard
// shapes a real arktype scope produces: a many-branch discriminated union, and a
// narrowed (unrepresentable) field that arktype emits as a `{type:object,
// format:'predicate'}` fallback branch. No app-specific schema is used.
const field = type({ kind: "'text'", label: 'string', value: 'string <= 100 | null' })
  .or({ kind: "'number'", label: 'string', value: '0 <= number <= 100 | null' })
  .or({ kind: "'toggle'", label: 'string', value: 'boolean' })
  .or({ kind: "'tags'", label: 'string', value: 'string[] | null' })
  .or({ kind: "'group'", label: 'string', rows: type({ id: 'string', cells: 'string[]' }).array() })
  .or({ kind: "'code'", label: 'string', value: type('string').narrow((s) => s.length > 0) })
const stressForm = type({ id: 'string', title: 'string | null', fields: field.array() })

const UNSUPPORTED = new Set([
  '$ref',
  'allOf',
  'if',
  'then',
  'else',
  'not',
  'patternProperties',
  '$defs',
  'definitions',
])

// Data-independent: walk the whole generated schema and collect any construct the
// navigator can't model. Proves a complex arktype schema stays inside the subset.
function collectUnsupported(node: unknown, path = '#', found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const [i, n] of node.entries()) collectUnsupported(n, `${path}/${i}`, found)
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (UNSUPPORTED.has(k)) found.push(`${path}/${k}`)
      collectUnsupported(v, `${path}/${k}`, found)
    }
  }
  return found
}

beforeEach(() => resetUnsupportedConstructs())

describe('stress: large messy arktype union stays in-subset and navigates', () => {
  const js = genJsonSchema(stressForm)
  const data = {
    id: 'x',
    title: null,
    fields: [
      { kind: 'text', label: 'L', value: 'hi' },
      { kind: 'number', label: 'N', value: 5 },
      { kind: 'toggle', label: 'T', value: true },
      { kind: 'code', label: 'C', value: 'xx' },
    ],
  }

  test('no unsupported constructs anywhere in the generated schema', () => {
    expect(collectUnsupported(js)).toEqual([])
  })

  test('fields nested in the union resolve to per-branch metadata', () => {
    expect(getSchemaMeta(js, data, 'fields[0].kind')).toEqual({ required: true })
    // text value: nullable string with maxLength (NOT number bounds from a sibling branch)
    expect(getSchemaMeta(js, data, 'fields[0].value')).toEqual({ required: false, maxLength: 100 })
    // number value: nullable, its own bounds
    expect(getSchemaMeta(js, data, 'fields[1].value')).toEqual({
      required: false,
      minimum: 0,
      maximum: 100,
    })
    // toggle value: boolean, required
    expect(getSchemaMeta(js, data, 'fields[2].value')).toEqual({ required: true })
    // narrowed/unrepresentable value (predicate-object branch): resolves, doesn't throw
    expect(getSchemaMeta(js, data, 'fields[3].value')).toHaveProperty('required')
    // walking the whole thing hits no unsupported construct
    expect([...unsupportedConstructs]).toEqual([])
  })
})

describe('predicate-object branch alongside string/null in a value union', () => {
  // mirrors an arktype value like `string <= 20 | <narrow> | null` — a non-null object
  // branch sitting next to the string branch; a string value must pick the string branch.
  const js: JSONSchema7 = {
    type: 'object',
    required: ['v'],
    properties: {
      v: {
        anyOf: [
          { type: 'string', maxLength: 20 },
          { type: 'object', format: 'predicate' },
          { type: 'null' },
        ],
      },
    },
  }

  test('string value resolves the string branch (maxLength), nullable', () => {
    expect(getSchemaMeta(js, { v: 'hello' }, 'v')).toEqual({ required: false, maxLength: 20 })
  })
  test('null value still surfaces the string constraint (first non-null branch)', () => {
    expect(getSchemaMeta(js, { v: null }, 'v')).toEqual({ required: false, maxLength: 20 })
  })
})
