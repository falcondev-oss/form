import type { JSONSchema7 } from 'json-schema'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  getSchemaMeta as navGetSchemaMeta,
  resetUnsupportedConstructs,
  unsupportedConstructs,
} from './schema-navigator'
import { fixtures, genJsonSchema } from './schema-navigator.fixtures'

function enumeratePaths(data: unknown, prefix = ''): string[] {
  const out: string[] = []
  if (data === null || typeof data !== 'object') return out
  if (Array.isArray(data)) {
    for (const [i, item] of data.entries()) {
      const p = `${prefix}[${i}]`
      out.push(p, ...enumeratePaths(item, p))
    }
  } else {
    for (const [k, v] of Object.entries(data)) {
      const p = prefix ? `${prefix}.${k}` : k
      out.push(p, ...enumeratePaths(v, p))
    }
  }
  return out
}

beforeEach(() => resetUnsupportedConstructs())

// Frozen golden of the metadata for EVERY enumerated path of every fixture.
// This was validated once against the json-schema-library output on all non-union
// paths (a throwaway differential run — all identical); the union paths are the
// intended fixes. The snapshot now pins the full surface so any future change to any
// path's metadata is caught in CI.
describe('navigator golden snapshot (all enumerated paths)', () => {
  for (const fx of fixtures) {
    test(fx.name, () => {
      const js = genJsonSchema(fx.schema)
      const out: Record<string, unknown> = {}
      for (const path of enumeratePaths(fx.data))
        out[path] = navGetSchemaMeta(js, fx.data as object, path)
      expect(out).toMatchSnapshot()
    })
  }
})

describe('navigator goldens for union paths (where the old library is broken)', () => {
  test('zod discriminated union: each branch gets its OWN constraints, not merged', () => {
    const fx = fixtures.find((f) => f.name.startsWith('zod: dynamic form'))!
    const js = genJsonSchema(fx.schema)
    const d = fx.data as object

    // TextInput value -> string(max 50), nullable
    expect(navGetSchemaMeta(js, d, 'sections[0].fields[0].value')).toEqual({
      required: false,
      maxLength: 50,
    })
    // NumberInput value -> number 0..999, nullable  (must NOT carry maxLength:50)
    expect(navGetSchemaMeta(js, d, 'sections[0].fields[1].value')).toEqual({
      required: false,
      minimum: 0,
      maximum: 999,
    })
    // discriminator + name are required (non-nullable) inside the resolved branch
    expect(navGetSchemaMeta(js, d, 'sections[0].fields[0].component')).toEqual({ required: true })
    expect(navGetSchemaMeta(js, d, 'sections[0].fields[0].name')).toEqual({ required: true })
    // Table nested array leaf -> string(max 10)
    expect(navGetSchemaMeta(js, d, 'sections[0].fields[2].columns[0].value[0]')).toEqual({
      required: false,
      maxLength: 10,
    })
  })

  test('arktype discriminated union: no cross-branch constraint bleed', () => {
    const fx = fixtures.find((f) => f.name.startsWith('arktype: dynamic form'))!
    const js = genJsonSchema(fx.schema)
    const d = fx.data as object
    // fields[0] is TextInput with value null: must be maxLength only, NOT number bounds
    expect(navGetSchemaMeta(js, d, 'sections[0].fields[0].value')).toEqual({
      required: false,
      maxLength: 50,
    })
    expect(navGetSchemaMeta(js, d, 'sections[0].fields[1].value')).toEqual({
      required: false,
      minimum: 0,
      maximum: 999,
    })
  })

  test('mid-edit: discriminator set but sibling values null -> metadata still resolves', () => {
    const fx = fixtures.find(
      (f) => f.name === 'zod: union mid-edit (discriminator set, value null)',
    )!
    const js = genJsonSchema(fx.schema)
    const d = fx.data as object
    expect(navGetSchemaMeta(js, d, 'f.value')).toEqual({ required: false, maxLength: 50 })
    expect(navGetSchemaMeta(js, d, 'f.name')).toEqual({ required: true }) // name is a required string
    expect(navGetSchemaMeta(js, d, 'f.component')).toEqual({ required: true })
  })
})

describe('robustness: empty / partial data never throws and still yields structural meta', () => {
  for (const fx of fixtures) {
    test(`${fx.name} — empty data`, () => {
      const js = genJsonSchema(fx.schema)
      // enumerate paths from the FULL data, but query them against EMPTY data
      const paths = enumeratePaths(fx.data)
      for (const path of paths) {
        expect(() => navGetSchemaMeta(js, {}, path)).not.toThrow()
      }
    })
  }

  test('nullable leaf keeps its constraints even when the value is null', () => {
    const fx = fixtures.find((f) => f.name === 'zod: nullable string present and absent')!
    const js = genJsonSchema(fx.schema)
    // b is null in the data; constraint must still be reported
    expect(navGetSchemaMeta(js, fx.data as object, 'b')).toEqual({ required: false, maxLength: 5 })
  })

  test('wrapper-level annotation (description) on a nullable field flows onto the branch', () => {
    const fx = fixtures.find((f) => f.name === 'zod: nullable string with wrapper description')!
    const js = genJsonSchema(fx.schema)
    expect(navGetSchemaMeta(js, fx.data as object, 'note')).toEqual({
      required: false,
      maxLength: 20,
      description: 'a note',
    })
    // nullable numeric bounds, value present
    expect(navGetSchemaMeta(js, fx.data as object, 'score')).toEqual({
      required: false,
      minimum: 1,
      maximum: 5,
    })
  })

  test('rest tuple: prefix element and additionalItems rest element both resolve', () => {
    const fx = fixtures.find((f) => f.name === 'zod: rest tuple (additionalItems)')!
    const js = genJsonSchema(fx.schema)
    expect(navGetSchemaMeta(js, fx.data as object, 't[0]')).toEqual({
      required: false,
      maxLength: 3,
    })
    expect(navGetSchemaMeta(js, fx.data as object, 't[1]')).toEqual({ required: false, minimum: 0 })
    expect(navGetSchemaMeta(js, fx.data as object, 't[2]')).toEqual({ required: false, minimum: 0 })
  })
})

describe('unsupported constructs degrade to {} and warn (incl. terminal nodes)', () => {
  test('terminal allOf → {} + warning', () => {
    resetUnsupportedConstructs()
    const js: JSONSchema7 = {
      type: 'object',
      properties: { a: { allOf: [{ maxLength: 5 }] } },
      required: ['a'],
    }
    const meta = navGetSchemaMeta(js, { a: 'x' }, 'a')
    expect(meta.maxLength).toBeUndefined()
    expect([...unsupportedConstructs]).toContain('allOf')
  })

  test('$ref anywhere on the walked path → warning', () => {
    resetUnsupportedConstructs()
    const js: JSONSchema7 = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/x' } },
      required: ['a'],
    }
    navGetSchemaMeta(js, { a: {} }, 'a')
    expect([...unsupportedConstructs]).toContain('$ref')
  })
})

describe('no unsupported constructs on the real (zod + arktype dynamic form) schemas', () => {
  test('warn-set stays empty', () => {
    resetUnsupportedConstructs()
    for (const fx of fixtures) {
      const js = genJsonSchema(fx.schema)
      for (const path of enumeratePaths(fx.data)) navGetSchemaMeta(js, fx.data as object, path)
    }
    expect([...unsupportedConstructs]).toEqual([])
  })
})
