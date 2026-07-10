import type { JSONSchema7 } from 'json-schema'
import { beforeEach, describe, expect, test } from 'vitest'
import z from 'zod'
import {
  getSchemaMeta,
  resetUnsupportedConstructs,
  unsupportedConstructs,
} from './schema-navigator'
import { genJsonSchema } from './schema-navigator.test-helpers'

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

describe('discriminated union: each branch keeps its own constraints (no cross-branch bleed)', () => {
  test('the resolved branch decides the leaf metadata', () => {
    const field = z.discriminatedUnion('component', [
      z.object({
        component: z.literal('TextInput'),
        name: z.string(),
        value: z.string().max(50).nullable(),
      }),
      z.object({
        component: z.literal('NumberInput'),
        name: z.string(),
        value: z.number().min(0).max(999).nullable(),
      }),
      z.object({
        component: z.literal('Table'),
        name: z.string(),
        columns: z.array(z.object({ id: z.string(), value: z.array(z.string().max(10)) })),
      }),
    ])
    const js = genJsonSchema(z.object({ fields: z.array(field) }))
    const data = {
      fields: [
        { component: 'TextInput', name: 'first', value: 'hi' },
        { component: 'NumberInput', name: 'age', value: 5 },
        { component: 'Table', name: 'tbl', columns: [{ id: 'c1', value: ['x', 'y'] }] },
      ],
    }

    // TextInput value -> string(max 50), nullable — must NOT carry number bounds
    expect(getSchemaMeta(js, data, 'fields[0].value')).toEqual({ required: false, maxLength: 50 })
    // NumberInput value -> number 0..999, nullable — must NOT carry maxLength:50
    expect(getSchemaMeta(js, data, 'fields[1].value')).toEqual({
      required: false,
      minimum: 0,
      maximum: 999,
    })
    // discriminator + name are required inside the resolved branch
    expect(getSchemaMeta(js, data, 'fields[0].component')).toEqual({ required: true })
    expect(getSchemaMeta(js, data, 'fields[0].name')).toEqual({ required: true })
    // Table nested array leaf -> string(max 10)
    expect(getSchemaMeta(js, data, 'fields[2].columns[0].value[0]')).toEqual({
      required: false,
      maxLength: 10,
    })
  })

  test('mid-edit: discriminator set but sibling values null still resolves the branch', () => {
    const field = z.discriminatedUnion('component', [
      z.object({
        component: z.literal('TextInput'),
        name: z.string(),
        value: z.string().max(50).nullable(),
      }),
      z.object({
        component: z.literal('NumberInput'),
        name: z.string(),
        value: z.number().min(0).max(999).nullable(),
      }),
    ])
    const js = genJsonSchema(z.object({ f: field }))
    const data = { f: { component: 'TextInput', name: null, value: null } }

    expect(getSchemaMeta(js, data, 'f.value')).toEqual({ required: false, maxLength: 50 })
    expect(getSchemaMeta(js, data, 'f.name')).toEqual({ required: true })
    expect(getSchemaMeta(js, data, 'f.component')).toEqual({ required: true })
  })
})

describe('nullable branches & wrapper-level annotations', () => {
  test('nullable leaf keeps its constraints whether the value is present or null', () => {
    const js = genJsonSchema(
      z.object({ a: z.string().max(5).nullable(), b: z.string().max(5).nullable() }),
    )
    const data = { a: 'hey', b: null }

    expect(getSchemaMeta(js, data, 'a')).toEqual({ required: false, maxLength: 5 })
    expect(getSchemaMeta(js, data, 'b')).toEqual({ required: false, maxLength: 5 })
  })

  test('a description on a nullable field (lands on the anyOf wrapper) flows onto the branch', () => {
    const js = genJsonSchema(
      z.object({
        note: z.string().max(20).nullable().describe('a note'),
        score: z.number().min(1).max(5).nullable(),
      }),
    )
    const data = { note: null, score: 3 }

    expect(getSchemaMeta(js, data, 'note')).toEqual({
      required: false,
      maxLength: 20,
      description: 'a note',
    })
    expect(getSchemaMeta(js, data, 'score')).toEqual({ required: false, minimum: 1, maximum: 5 })
  })
})

describe('structural shapes navigate to the right leaf', () => {
  test('record (additionalProperties schema)', () => {
    const js = genJsonSchema(z.object({ meta: z.record(z.string(), z.string().max(8)) }))
    expect(getSchemaMeta(js, { meta: { k1: 'v1' } }, 'meta.k1')).toEqual({
      required: false,
      maxLength: 8,
    })
  })

  test('tuple (prefixItems): each position keeps its own constraint', () => {
    const js = genJsonSchema(z.object({ pair: z.tuple([z.string().max(3), z.number().max(9)]) }))
    const data = { pair: ['ab', 4] }
    expect(getSchemaMeta(js, data, 'pair[0]')).toEqual({ required: false, maxLength: 3 })
    expect(getSchemaMeta(js, data, 'pair[1]')).toEqual({ required: false, maximum: 9 })
  })

  test('rest tuple (draft-07 items[] + additionalItems)', () => {
    const js = genJsonSchema(z.object({ t: z.tuple([z.string().max(3)]).rest(z.number().min(0)) }))
    const data = { t: ['ab', 5, 6] }
    expect(getSchemaMeta(js, data, 't[0]')).toEqual({ required: false, maxLength: 3 })
    expect(getSchemaMeta(js, data, 't[1]')).toEqual({ required: false, minimum: 0 })
    expect(getSchemaMeta(js, data, 't[2]')).toEqual({ required: false, minimum: 0 })
  })

  test('nested arrays of scalars', () => {
    const js = genJsonSchema(z.object({ matrix: z.array(z.array(z.number().max(9))) }))
    expect(getSchemaMeta(js, { matrix: [[1, 2], [3]] }, 'matrix[0][1]')).toEqual({
      required: false,
      maximum: 9,
    })
  })

  test('deeply nested objects carry the leaf annotation', () => {
    const js = genJsonSchema(
      z.object({
        a: z.object({ b: z.object({ c: z.object({ d: z.string().max(4).describe('deep') }) }) }),
      }),
    )
    expect(getSchemaMeta(js, { a: { b: { c: { d: 'yo' } } } }, 'a.b.c.d')).toEqual({
      required: true,
      maxLength: 4,
      description: 'deep',
    })
  })
})

describe('unsupported constructs degrade to {} and warn (incl. terminal nodes)', () => {
  test('terminal allOf -> {} + warning', () => {
    const js: JSONSchema7 = {
      type: 'object',
      properties: { a: { allOf: [{ maxLength: 5 }] } },
      required: ['a'],
    }
    const meta = getSchemaMeta(js, { a: 'x' }, 'a')
    expect(meta.maxLength).toBeUndefined()
    expect([...unsupportedConstructs]).toContain('allOf')
  })

  test('$ref anywhere on the walked path -> warning', () => {
    const js: JSONSchema7 = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/x' } },
      required: ['a'],
    }
    getSchemaMeta(js, { a: {} }, 'a')
    expect([...unsupportedConstructs]).toContain('$ref')
  })
})

describe('robustness on a real-shaped dynamic-form schema', () => {
  const field = z.discriminatedUnion('component', [
    z.object({
      component: z.literal('TextInput'),
      name: z.string(),
      value: z.string().max(50).nullable(),
    }),
    z.object({
      component: z.literal('NumberInput'),
      name: z.string(),
      value: z.number().min(0).max(999).nullable(),
    }),
    z.object({
      component: z.literal('Table'),
      name: z.string(),
      columns: z.array(z.object({ id: z.string(), value: z.array(z.string().max(10)) })),
    }),
  ])
  const js = genJsonSchema(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      sections: z.array(z.object({ name: z.string(), fields: z.array(field) })),
    }),
  )
  const data = {
    id: 'f1',
    name: 'My form',
    sections: [
      {
        name: 'Sec A',
        fields: [
          { component: 'TextInput', name: 'first', value: 'hi' },
          { component: 'NumberInput', name: 'age', value: 5 },
          { component: 'Table', name: 'tbl', columns: [{ id: 'c1', value: ['x', 'y'] }] },
        ],
      },
    ],
  }

  test('querying every path against EMPTY data never throws', () => {
    for (const path of enumeratePaths(data)) expect(() => getSchemaMeta(js, {}, path)).not.toThrow()
  })

  test('the schema stays entirely within the navigator-supported subset', () => {
    for (const path of enumeratePaths(data)) getSchemaMeta(js, data, path)
    expect([...unsupportedConstructs]).toEqual([])
  })
})
