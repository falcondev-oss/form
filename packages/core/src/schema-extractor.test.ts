import { type } from 'arktype'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { getSchemaMeta } from './schema-extractor'
import { toJsonSchema } from './schema-meta'

describe('primitives', () => {
  test('draft-2020-12', () => {
    const schema = z.object({})

    const jsonSchema = toJsonSchema(schema)
    expect(jsonSchema.$schema).toContain('2020-12')
  })

  test('optional/required object properties', () => {
    const schema = z.object({
      optional: z.string().optional(),
      required: z.string(),
    })
    const jsonSchema = toJsonSchema(schema)
    expect(jsonSchema).toMatchSnapshot()

    const metaRoot = getSchemaMeta(jsonSchema, {}, '')
    expect(metaRoot.required).toBe(true)

    const metaOptional = getSchemaMeta(jsonSchema, {}, 'optional')
    expect(metaOptional.required).toBe(false)

    const metaRequired = getSchemaMeta(jsonSchema, {}, 'required')
    expect(metaRequired.required).toBe(true)
  })

  test('number minimum/maximum', () => {
    const schema = z.object({
      min: z.number().min(1),
      max: z.number().max(10),
      gt: z.number().gt(1),
      lt: z.number().lt(10),
    })
    const jsonSchema = toJsonSchema(schema)
    expect(jsonSchema).toMatchSnapshot()

    const metaMin = getSchemaMeta(jsonSchema, {}, 'min')
    expect(metaMin.minimum).toBe(1)
    expect(metaMin.exclusiveMinimum).toBeUndefined()

    const metaMax = getSchemaMeta(jsonSchema, {}, 'max')
    expect(metaMax.maximum).toBe(10)
    expect(metaMax.exclusiveMaximum).toBeUndefined()

    const metaGt = getSchemaMeta(jsonSchema, {}, 'gt')
    expect(metaGt.minimum).toBeUndefined()
    expect(metaGt.exclusiveMinimum).toBe(1)

    const metaLt = getSchemaMeta(jsonSchema, {}, 'lt')
    expect(metaLt.maximum).toBeUndefined()
    expect(metaLt.exclusiveMaximum).toBe(10)
  })

  test('string minLength/maxLength', () => {
    const schema = z.object({
      min: z.string().min(1),
      max: z.string().max(10),
    })
    const jsonSchema = toJsonSchema(schema)
    expect(jsonSchema).toMatchSnapshot()

    const metaMin = getSchemaMeta(jsonSchema, {}, 'min')
    expect(metaMin.minLength).toBe(1)
    expect(metaMin.maxLength).toBeUndefined()

    const metaMax = getSchemaMeta(jsonSchema, {}, 'max')
    expect(metaMax.minLength).toBeUndefined()
    expect(metaMax.maxLength).toBe(10)
  })

  describe('date', () => {
    const zodSchema = z.object({
      min: z.date().min(new Date('2020-01-01')),
      max: z.date().max(new Date('2020-12-31')),
    })
    const arktypeSchema = type({
      min: "Date >= d'2020-01-01'",
      max: "Date <= d'2020-12-31'",
    })
    test.for([
      { name: 'zod', schema: zodSchema },
      { name: 'arktype', schema: arktypeSchema },
    ] as const)('min/max – $name', ({ schema }, { expect }) => {
      const jsonSchema = toJsonSchema(schema)
      expect(jsonSchema).toMatchSnapshot()
      expect((jsonSchema.properties?.min as any)?.format).toBe('epoch')
      expect((jsonSchema.properties?.min as any)?.type).toBe('integer')

      const metaMin = getSchemaMeta(jsonSchema, {}, 'min')
      expect(metaMin.minimum).toBe(new Date('2020-01-01').getTime())
      expect(metaMin.exclusiveMinimum).toBeUndefined()

      const metaMax = getSchemaMeta(jsonSchema, {}, 'max')
      expect(metaMax.maximum).toBe(new Date('2020-12-31').getTime())
      expect(metaMax.exclusiveMaximum).toBeUndefined()
    })
  })

  describe('unrepresentable types', () => {
    const zodSchema = z.object({
      bigint: z.bigint(),
      symbol: z.symbol(),
      undefined: z.undefined(),
      map: z.map(z.string(), z.string()),
      set: z.set(z.string()),
    })
    const arktypeSchema = type({
      bigint: 'bigint',
      symbol: 'symbol',
      undefined: 'undefined',
      map: 'Map',
      set: 'Set',
    })

    test.for([
      { name: 'zod', schema: zodSchema },
      { name: 'arktype', schema: arktypeSchema },
    ] as const)('unrepresentable types – $name', ({ schema }, { expect }) => {
      const jsonSchema = toJsonSchema(schema)
      expect(jsonSchema).toMatchSnapshot()
    })
  })
})

describe('inference', () => {
  test('nullable is optional', () => {
    const schema = z.object({
      nullable: z.string().nullable(),
      optional: z.string().optional(),
    })
    const jsonSchema = toJsonSchema(schema)
    expect(jsonSchema).toMatchSnapshot()

    const metaNullable = getSchemaMeta(jsonSchema, {}, 'nullable')
    expect(metaNullable.required).toBe(false)

    const metaOptional = getSchemaMeta(jsonSchema, {}, 'optional')
    expect(metaOptional.required).toBe(false)
  })

  describe('discriminated union', () => {
    const zodSchema = z.discriminatedUnion('type', [
      z.object({ type: z.literal('string'), str: z.string().meta({ title: 'String' }) }),
      z.object({ type: z.literal('number'), nr: z.number().meta({ title: 'Number' }) }),
    ])
    const arktypeSchema = type.or(
      type({ type: "'string'", str: type('string').configure({ title: 'String' }) }),
      type({ type: "'number'", nr: type('number').configure({ title: 'Number' }) }),
    )

    test.for([
      { name: 'zod', schema: zodSchema },
      { name: 'arktype', schema: arktypeSchema },
    ] as const)('discriminated unions – $name', ({ schema }, { expect }) => {
      const jsonSchema = toJsonSchema(schema)
      expect(jsonSchema).toMatchSnapshot()

      const metaStr = getSchemaMeta(jsonSchema, { type: 'string' }, 'str')
      expect(metaStr.title).toEqual('String')

      const metaNr = getSchemaMeta(jsonSchema, { type: 'number' }, 'nr')
      expect(metaNr.title).toEqual('Number')

      const metaStrNr = getSchemaMeta(jsonSchema, { type: 'string' }, 'nr')
      expect(metaStrNr).toEqual({})
    })
  })

  test('primitive unions', () => {
    const schema = z.object({
      value: z.union([
        z.string().meta({ title: 'String' }),
        z.number().meta({ title: 'Number' }),
        z.boolean().meta({ title: 'Boolean' }),
        z.object({}).meta({ title: 'Object' }),
      ]),
    })
    const jsonSchema = toJsonSchema(schema)
    expect(jsonSchema).toMatchSnapshot()

    const metaString = getSchemaMeta(jsonSchema, { value: '' }, 'value')
    expect(metaString.title).toEqual('String')

    const metaNumber = getSchemaMeta(jsonSchema, { value: 1 }, 'value')
    expect(metaNumber.title).toEqual('Number')

    const metaBoolean = getSchemaMeta(jsonSchema, { value: true }, 'value')
    expect(metaBoolean.title).toEqual('Boolean')

    const metaObject = getSchemaMeta(jsonSchema, { value: {} }, 'value')
    expect(metaObject.title).toEqual('Object')

    const metaUnknown = getSchemaMeta(jsonSchema, { value: null }, 'value')
    expect(metaUnknown).toEqual({ required: true, title: 'String' }) // first union type is used as fallback
  })

  test('enum unions', () => {
    const schema = z.object({
      value: z.union([
        z.literal(['C']).meta({ title: 'LiteralC' }),
        z.enum(['A', 'B']).meta({ title: 'EnumAB' }),
      ]),
    })
    const jsonSchema = toJsonSchema(schema)
    expect(jsonSchema).toMatchSnapshot()

    const metaEnumAB = getSchemaMeta(jsonSchema, { value: 'A' }, 'value')
    expect(metaEnumAB.title).toEqual('EnumAB')

    const metaLiteralC = getSchemaMeta(jsonSchema, { value: 'C' }, 'value')
    expect(metaLiteralC.title).toEqual('LiteralC')
  })

  test('match first positive assertions', () => {
    const schema = z.object({
      value: z
        .string()
        .max(2)
        .meta({ title: 'Short' })
        .or(z.string().min(5).meta({ title: 'Long' })),
    })
    const jsonSchema = toJsonSchema(schema)
    expect(jsonSchema).toMatchSnapshot()

    const metaShort = getSchemaMeta(jsonSchema, { value: '1' }, 'value')
    expect(metaShort.title).toEqual('Short')
    expect(metaShort.maxLength).toEqual(2)

    const metaLong = getSchemaMeta(jsonSchema, { value: '12345' }, 'value')
    expect(metaLong.title).toEqual('Long')
    expect(metaLong.minLength).toEqual(5)
  })

  test('discriminated union > union', () => {
    // zod object.value discriminated union, then one element has array of union
    const schema = z.object({
      value: z.discriminatedUnion('type', [
        z.object({
          type: z.literal('string'),
          str: z.string().meta({ title: 'String' }),
        }),
        z.object({
          type: z.literal('array'),
          arr: z
            .array(
              z.union([z.string().meta({ title: 'String' }), z.number().meta({ title: 'Number' })]),
            )
            .min(2)
            .meta({ title: 'Array' }),
        }),
      ]),
    })
    const jsonSchema = toJsonSchema(schema)
    expect(jsonSchema).toMatchSnapshot()

    const metaStr = getSchemaMeta(jsonSchema, { value: { type: 'string', str: '' } }, 'value.str')
    expect(metaStr.title).toEqual('String')

    const metaArr = getSchemaMeta(jsonSchema, { value: { type: 'array', arr: [] } }, 'value.arr')
    expect(metaArr).toEqual({ title: 'Array', required: true, minLength: 2 })

    const metaArrStr = getSchemaMeta(
      jsonSchema,
      { value: { type: 'array', arr: [0, ''] } },
      'value.arr[1]',
    )
    expect(metaArrStr.title).toEqual('String')

    const metaArrNr = getSchemaMeta(
      jsonSchema,
      { value: { type: 'array', arr: [0] } },
      'value.arr[0]',
    )
    expect(metaArrNr.title).toEqual('Number')
  })

  test('double nested union', () => {
    const schema = z.object({
      value: z.union([
        z.string().meta({ title: 'String' }),
        z.union([
          z.number().meta({ title: 'Number' }).nullable(),
          z.boolean().meta({ title: 'Boolean' }),
        ]),
      ]),
    })
    const jsonSchema = toJsonSchema(schema)
    expect(jsonSchema).toMatchSnapshot()

    const metaString = getSchemaMeta(jsonSchema, { value: '' }, 'value')
    expect(metaString.title).toEqual('String')
    expect(metaString.required).toBe(true)

    const metaNumber = getSchemaMeta(jsonSchema, { value: 1 }, 'value')
    expect(metaNumber.title).toEqual('Number')
    expect(metaNumber.required).toBe(false)

    const metaBoolean = getSchemaMeta(jsonSchema, { value: true }, 'value')
    expect(metaBoolean.title).toEqual('Boolean')
    expect(metaBoolean.required).toBe(true)
  })

  test('tuples', () => {
    const schema = z.object({
      value: z.union([
        z.tuple([z.string().meta({ title: 'String' }), z.number().meta({ title: 'Number' })]),
        z.tuple([z.boolean().meta({ title: 'Boolean' }), z.string().max(5)]),
      ]),
    })
    const jsonSchema = toJsonSchema(schema)
    expect(jsonSchema).toMatchSnapshot()

    const meta1 = getSchemaMeta(jsonSchema, { value: [null, 1] }, 'value[1]')
    expect(meta1).toEqual({ required: true, title: 'Number' })

    const meta2 = getSchemaMeta(jsonSchema, { value: [true, null] }, 'value[1]')
    expect(meta2).toEqual({ required: true, maxLength: 5 })
  })
})

describe('overrides', () => {
  test('inherit meta of union parent', () => {
    const schema = z.object({
      value: z
        .union([z.string().min(2), z.number().min(1)])
        .meta({ title: 'Value' })
        .nullable(),
    })

    const jsonSchema = toJsonSchema(schema)
    expect(jsonSchema).toMatchSnapshot()

    const metaString = getSchemaMeta(jsonSchema, { value: 'abc' }, 'value')
    expect(metaString).toEqual({
      title: 'Value',
      required: false,
      minLength: 2,
    })

    const metaNumber = getSchemaMeta(jsonSchema, { value: 5 }, 'value')
    expect(metaNumber).toEqual({
      title: 'Value',
      required: false,
      minimum: 1,
    })

    const metaNull = getSchemaMeta(jsonSchema, { value: null }, 'value')
    expect(metaNull).toEqual({
      minLength: 2, // fallback to first union elements meta
      required: false,
    })
  })

  test('child meta overrides parent meta', () => {
    const schema = z.object({
      value: z
        .union([z.string().meta({ title: 'String' }), z.number().meta({ title: 'Number' })])
        .nullable()
        .meta({ title: 'Value' }),
    })

    const jsonSchema = toJsonSchema(schema)
    expect(jsonSchema).toMatchSnapshot()

    const metaString = getSchemaMeta(jsonSchema, { value: 'abc' }, 'value')
    expect(metaString).toEqual({
      title: 'String',
      required: false,
    })

    const metaNull = getSchemaMeta(jsonSchema, { value: null }, 'value')
    expect(metaNull).toEqual({
      title: 'Value',
      required: false,
    })
  })

  test('no value fallback to null element meta', () => {
    const schema = z.object({
      value: z.union([z.string().meta({ title: 'String' }), z.null().meta({ title: 'Null' })]),
    })
    const jsonSchema = toJsonSchema(schema)
    expect(jsonSchema).toMatchSnapshot()

    const metaNull = getSchemaMeta(jsonSchema, {}, 'value')
    // only if null element has meta set, otherwise fallback to first union element meta
    expect(metaNull).toEqual({
      title: 'Null',
      required: true,
    })
  })
})

describe('edge cases', () => {
  test('empty object', () => {
    const schema = z.object({})
    const jsonSchema = toJsonSchema(schema)
    expect(jsonSchema).toMatchSnapshot()

    const meta = getSchemaMeta(jsonSchema, {}, '')
    expect(meta).toEqual({ required: true })
  })

  test('dot in property name', () => {
    const schema = z.object({
      'a.b': z.string().describe('A dot in the property name'),
    })
    const jsonSchema = toJsonSchema(schema)
    expect(jsonSchema).toMatchSnapshot()

    const meta = getSchemaMeta(jsonSchema, {}, 'a.b')
    expect(meta).toEqual({ required: true, description: 'A dot in the property name' })
  })
})
