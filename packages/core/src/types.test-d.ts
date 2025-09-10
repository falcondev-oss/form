import type { UnionToTuple } from 'type-fest'
import type { BuildFormFieldAccessors, FormField, FormFieldAccessor, NullableDeep } from './types'
import { assertType, describe, test } from 'vitest'
import z from 'zod'
import { useFormCore } from './core'

const brand = Symbol('Brand')

test('nullableDeep', () => {
  type Values = {
    keyOptional?: string
    nullable: number | null
    valueOptional: string | undefined
    object: {
      nested: string
    }
    branded: {
      start: string
      end: string
      [brand]: 'DateRange'
    }
    objectWithFunctions: {
      fn: () => void
    }
    array: string[]
  }
  type DiscriminatedUnionValues =
    | {
        type: 'A'
        a: string
      }
    | {
        type: 'B'
        b: number
      }

  type RecordValues = Record<
    string,
    {
      value: string
    }
  >

  assertType<{
    keyOptional?: string | null | undefined
    nullable: number | null
    valueOptional: string | null | undefined
    object: {
      nested: string | null
    } | null
    branded: {
      start: string
      end: string
      [brand]: 'DateRange'
    } | null
    objectWithFunctions: {
      fn: () => void
    } | null
    array: (string | null)[] | null
  } | null>({} as NullableDeep<Values>)

  assertType<
    | {
        type: 'A'
        a: string | null
      }
    | {
        type: 'B'
        b: number | null
      }
    | null
  >({} as NullableDeep<DiscriminatedUnionValues>)

  assertType<
    Record<
      string,
      {
        value: string | null
      } | null
    >
  >({} as NullableDeep<RecordValues>)
})

describe('discriminated union', () => {
  test('discriminator field', () => {
    // eslint-disable-next-line unused-imports/no-unused-vars
    const form = useFormCore({
      schema: z.object({
        union: z.discriminatedUnion('type', [
          z.object({ type: z.literal('A'), a: z.string() }),
          z.object({ type: z.literal('B'), b: z.number() }),
        ]),
      }),
      sourceValues: {
        union: {
          type: 'A',
          a: 'test',
        },
      },
      async submit() {},
    })
    assertType<FormField<'A' | 'B'>>({} as ReturnType<typeof form.fields.union.type.$use>)
  })

  test('detects discriminated union', () => {
    // eslint-disable-next-line unused-imports/no-unused-vars
    const form = useFormCore({
      schema: z.object({
        string: z.discriminatedUnion('discriminator', [
          z.object({ discriminator: z.literal('A'), a: z.string() }),
          z.object({ discriminator: z.literal('B'), b: z.number() }),
        ]),
        boolean: z.discriminatedUnion('discriminator', [
          z.object({ discriminator: z.literal(true), a: z.boolean() }),
          z.object({ discriminator: z.literal(false), b: z.boolean() }),
        ]),
        number: z.discriminatedUnion('discriminator', [
          z.object({ discriminator: z.literal(1), a: z.boolean() }),
          z.object({ discriminator: z.literal(2), b: z.boolean() }),
        ]),
      }),
      sourceValues: {
        string: null,
        boolean: null,
        number: null,
      },
      async submit() {},
    })

    // discriminated union field value still nullable
    assertType<'A' | 'B' | null>({} as ReturnType<typeof form.fields.string.$use>['value'])
    assertType<boolean | null>({} as ReturnType<typeof form.fields.boolean.$use>['value'])
    assertType<1 | 2 | null>({} as ReturnType<typeof form.fields.number.$use>['value'])

    // has discriminator option
    assertType<
      | {
          discriminator?: 'discriminator' | undefined
        }
      | undefined
    >({} as Parameters<typeof form.fields.string.$use>[0])
    assertType<
      | {
          discriminator?: 'discriminator' | undefined
        }
      | undefined
    >({} as Parameters<typeof form.fields.boolean.$use>[0])
    assertType<
      | {
          discriminator?: 'discriminator' | undefined
        }
      | undefined
    >({} as Parameters<typeof form.fields.number.$use>[0])

    // discriminator field has correct value type
    assertType<UnionToTuple<'A' | 'B' | null>>(
      {} as UnionToTuple<ReturnType<typeof form.fields.string.discriminator.$use>['value']>,
    )
    assertType<UnionToTuple<true | false | null>>(
      {} as UnionToTuple<ReturnType<typeof form.fields.boolean.discriminator.$use>['value']>,
    )
    assertType<UnionToTuple<1 | 2 | null>>(
      {} as UnionToTuple<ReturnType<typeof form.fields.number.discriminator.$use>['value']>,
    )
  })

  test('literal union discriminator', () => {
    assertType<FormFieldAccessor<'a'> | FormFieldAccessor<'b' | 'c'>>(
      {} as BuildFormFieldAccessors<
        | {
            discriminator: 'a'
            a: string
          }
        | {
            discriminator: 'b' | 'c'
            bc: number
          }
      >['discriminator'],
    )
  })
})

test('FormField', () => {
  const form = useFormCore({
    schema: z.object({
      number: z.number(),
    }),
    sourceValues: {
      number: null,
    },
    async submit() {},
  })
  const _: {
    field: FormField<string | null>
  } = {
    // @ts-expect-error this should not work because FormField<number | null> is not assignable to FormField<string | null>
    field: form.fields.number.$use(),
  }
})
