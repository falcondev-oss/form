/* eslint-disable ts/no-unsafe-member-access, ts/no-unsafe-assignment, ts/no-unsafe-return, ts/no-unsafe-call, ts/no-unsafe-argument -- mirrors core.ts's untyped zod/arktype JSON-schema-generation callbacks */
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { JSONSchema7 } from 'json-schema'
import { type } from 'arktype'
import { match } from 'ts-pattern'
import z from 'zod'

/**
 * Replicates the exact JSON-schema generation that core.ts (`useFormCore`) does,
 * so fixtures exercise the same shapes production feeds to getSchemaMeta.
 */
export function genJsonSchema(schema: { '~standard': any }): JSONSchema7 {
  const standardSchema = schema['~standard']

  const zodUnrepresentableTypes = new Set([
    'bigint',
    'symbol',
    'undefined',
    'void',
    'date',
    'map',
    'set',
    'transform',
    'nan',
    'custom',
  ])

  const libraryOptions = match(standardSchema.vendor)
    .with('zod', () => ({
      unrepresentable: 'any',
      override(ctx: any) {
        const zod = ctx.zodSchema._zod
        if (zod.def.type === 'date') {
          ctx.jsonSchema.type = 'integer'
          ctx.jsonSchema.format = 'epoch'
          ctx.jsonSchema.minimum = zod.bag.minimum?.getTime()
          ctx.jsonSchema.maximum = zod.bag.maximum?.getTime()
          return
        }
        if (zodUnrepresentableTypes.has(zod.def.type)) {
          ctx.jsonSchema.type = 'object'
          ctx.jsonSchema.format = zod.def.type
        }
      },
    }))
    .with('arktype', () => ({
      fallback: {
        default: (ctx: any) => ({ ...ctx.base, type: 'object', format: ctx.code }),
        date: (ctx: any) => ({
          ...ctx.base,
          type: 'integer',
          format: 'epoch',
          exclusiveMaximum: ctx.before?.getTime(),
          exclusiveMinimum: ctx.after?.getTime(),
        }),
      },
    }))
    .otherwise(() => undefined)

  return standardSchema.jsonSchema.input({ target: 'draft-07', libraryOptions })
}

export type Fixture = {
  name: string
  vendor: 'zod' | 'arktype'
  schema: StandardSchemaV1
  data: unknown
}

// ── zod-side field building blocks (a form-builder-style discriminated union) ──
const zTextInput = z.object({
  component: z.literal('TextInput'),
  name: z.string(),
  value: z.string().max(50).nullable(),
})
const zNumberInput = z.object({
  component: z.literal('NumberInput'),
  name: z.string(),
  value: z.number().min(0).max(999).nullable(),
})
const zTable = z.object({
  component: z.literal('Table'),
  name: z.string(),
  columns: z.array(z.object({ id: z.string(), value: z.array(z.string().max(10)) })),
})
const zField = z.discriminatedUnion('component', [zTextInput, zNumberInput, zTable])
const zDynamicForm = z.object({
  id: z.string(),
  name: z.string().nullable(),
  isTemplate: z.boolean(),
  sections: z.array(z.object({ name: z.string(), fields: z.array(zField) })),
})

// ── arktype mirror ──
const aField = type({ component: "'TextInput'", name: 'string', value: 'string <= 50 | null' })
  .or({ component: "'NumberInput'", name: 'string', value: '0 <= number <= 999 | null' })
  .or({
    component: "'Table'",
    name: 'string',
    columns: type({ id: 'string', value: 'string[]' }).array(),
  })
const aDynamicForm = type({
  id: 'string',
  name: 'string | null',
  isTemplate: 'boolean',
  sections: type({ name: 'string', fields: aField.array() }).array(),
})

export const fixtures: Fixture[] = [
  // ─────────── real-shaped (mirrors the app) ───────────
  {
    name: 'zod: dynamic form (TextInput + NumberInput + Table)',
    vendor: 'zod',
    schema: zDynamicForm,
    data: {
      id: 'f1',
      name: 'My form',
      isTemplate: false,
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
    },
  },
  {
    name: 'arktype: dynamic form (TextInput + NumberInput + Table)',
    vendor: 'arktype',
    schema: aDynamicForm,
    data: {
      id: 'f1',
      name: null,
      isTemplate: true,
      sections: [
        {
          name: 'Sec A',
          fields: [
            { component: 'TextInput', name: 'first', value: null },
            { component: 'NumberInput', name: 'age', value: 5 },
            { component: 'Table', name: 'tbl', columns: [{ id: 'c1', value: ['x'] }] },
          ],
        },
      ],
    },
  },

  // ─────────── further synthetic permutations / edge shapes ───────────

  // flat scalars: constraints, nullable, optional, enum, integer, date(epoch)
  {
    name: 'zod: flat scalars (min/max, nullable, optional, enum, int, date)',
    vendor: 'zod',
    schema: z.object({
      title: z.string().min(2).max(20).describe('the title'),
      count: z.number().int().min(1).max(10),
      ratio: z.number().min(0).max(1),
      flag: z.boolean(),
      color: z.enum(['red', 'green', 'blue']),
      maybe: z.string().nullable(),
      opt: z.string().optional(),
      when: z.date(),
    }),
    data: {
      title: 'hello',
      count: 3,
      ratio: 0.5,
      flag: true,
      color: 'green',
      maybe: null,
      opt: 'x',
      when: 1_700_000_000_000,
    },
  },
  {
    name: 'arktype: flat scalars (bounds, nullable, optional, enum, date)',
    vendor: 'arktype',
    schema: type({
      'title': '2 <= string <= 20',
      'count': '1 <= number.integer <= 10',
      'flag': 'boolean',
      'color': "'red' | 'green' | 'blue'",
      'maybe': 'string | null',
      'opt?': 'string',
      'when': 'Date',
    }),
    data: {
      title: 'hello',
      count: 3,
      flag: false,
      color: 'blue',
      maybe: 'v',
      opt: 'x',
      when: new Date(1_700_000_000_000),
    },
  },

  // nullable value that is currently non-null vs null (branch selection by type)
  {
    name: 'zod: nullable string present and absent',
    vendor: 'zod',
    schema: z.object({ a: z.string().max(5).nullable(), b: z.string().max(5).nullable() }),
    data: { a: 'hey', b: null },
  },

  // discriminated union at the ROOT-ish level, both branches exercised
  {
    name: 'zod: discriminated union array, both branches + deep leaf',
    vendor: 'zod',
    schema: z.object({ items: z.array(zField) }),
    data: {
      items: [
        { component: 'TextInput', name: 'a', value: 'short' },
        { component: 'NumberInput', name: 'b', value: 7 },
        { component: 'Table', name: 'c', columns: [{ id: 'z', value: ['q'] }] },
      ],
    },
  },

  // union where value is mid-edit: discriminator set, sibling fields null
  {
    name: 'zod: union mid-edit (discriminator set, value null)',
    vendor: 'zod',
    schema: z.object({ f: zField }),
    data: { f: { component: 'TextInput', name: null, value: null } },
  },

  // nested arrays of scalars
  {
    name: 'zod: nested arrays of scalars',
    vendor: 'zod',
    schema: z.object({ matrix: z.array(z.array(z.number().max(9))) }),
    data: { matrix: [[1, 2], [3]] },
  },

  // tuple (zod) -> prefixItems / items array edge
  {
    name: 'zod: tuple',
    vendor: 'zod',
    schema: z.object({ pair: z.tuple([z.string().max(3), z.number().max(9)]) }),
    data: { pair: ['ab', 4] },
  },

  // deeply nested object chain
  {
    name: 'zod: deep nested objects',
    vendor: 'zod',
    schema: z.object({
      a: z.object({ b: z.object({ c: z.object({ d: z.string().max(4).describe('deep') }) }) }),
    }),
    data: { a: { b: { c: { d: 'yo' } } } },
  },

  // record / additionalProperties schema
  {
    name: 'zod: record (additionalProperties schema)',
    vendor: 'zod',
    schema: z.object({ meta: z.record(z.string(), z.string().max(8)) }),
    data: { meta: { k1: 'v1', k2: 'v2' } },
  },

  // nullable field whose annotation (description) lands on the anyOf *wrapper*
  {
    name: 'zod: nullable string with wrapper description',
    vendor: 'zod',
    schema: z.object({
      note: z.string().max(20).nullable().describe('a note'),
      score: z.number().min(1).max(5).nullable(),
    }),
    data: { note: null, score: 3 },
  },

  // rest tuple (draft-07: items[] + additionalItems)
  {
    name: 'zod: rest tuple (additionalItems)',
    vendor: 'zod',
    schema: z.object({
      t: z.tuple([z.string().max(3)]).rest(z.number().min(0)),
    }),
    data: { t: ['ab', 5, 6] },
  },
]
