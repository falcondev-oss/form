import type { ZodLiteral, ZodType, ZodUnion } from 'zod'
import { describe, expect, test } from 'vitest'
import z from 'zod'
import { getValidatorByPath } from './validator'

describe('getValidatorByPath', () => {
  test('object', () => {
    const schema = z.object({
      nested: z.object({
        name: z.string(),
      }),
    })
    expect(getValidatorByPath(schema, ['nested', 'name'])).toBeInstanceOf(z.ZodString)
  })

  test('array', () => {
    const schema = z.object({
      array: z.array(
        z.object({
          name: z.string(),
        }),
      ),
    })
    expect(getValidatorByPath(schema, ['array', '[0]', 'name'])).toBeInstanceOf(z.ZodString)
  })

  test('discriminated union', () => {
    const schema = z.object({
      union: z.discriminatedUnion('type', [
        z.object({
          type: z.literal('A'),
          name: z.string(),
          shared: z.number(),
        }),
        z.object({
          type: z.literal('B'),
          age: z.number(),
          shared: z.string(),
        }),
      ]),
    })
    expect(getValidatorByPath(schema, ['union', 'type'])).toBeInstanceOf(z.ZodUnion)
    expect(
      (getValidatorByPath(schema, ['union', 'type']) as ZodUnion<ZodLiteral[]>).options.map(
        (l) => l.value,
      ),
    ).toEqual(['A', 'B'])
    expect(getValidatorByPath(schema, ['union', 'name'])).toBeInstanceOf(z.ZodString)
    expect(getValidatorByPath(schema, ['union', 'age'])).toBeInstanceOf(z.ZodNumber)
    expect(getValidatorByPath(schema, ['union', 'shared'])).toBeInstanceOf(z.ZodUnion)
    expect(
      (getValidatorByPath(schema, ['union', 'shared']) as ZodUnion<ZodType[]>).options.map(
        (l) => l.def.type,
      ),
    ).toEqual(['number', 'string'])
  })
})
