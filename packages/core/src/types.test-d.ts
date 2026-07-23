/* eslint-disable ts/no-unnecessary-type-assertion */
import type { UnionToTuple } from 'type-fest'
import type {
  BuildFormFieldAccessors,
  FormField,
  FormFieldAccessor,
  GetDiscriminator,
  NullableDeep,
} from './types'
import { assertType, describe, expectTypeOf, test } from 'vitest'
import z from 'zod'
import { useFormCore } from './core'

declare module './types' {
  interface Register {
    events: {
      toForm: { submitted: { id: number }; ping: void }
      toField: { highlight: { color: string } }
    }
  }
}

const brand = Symbol('Brand')

test('NullableDeep', () => {
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
      a?: string
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
      a?: string
      fn: () => void
    } | null
    array: (string | null)[] | null
  } | null>({} as NullableDeep<Values>)

  assertType<UnionToTuple<'A' | 'B' | null>>(
    {} as UnionToTuple<NonNullable<NullableDeep<DiscriminatedUnionValues>>['type']>,
  )

  assertType<
    Record<
      string,
      {
        value: string | null
      } | null
    >
  >({} as NullableDeep<RecordValues>)
})

test('GetDiscriminator', () => {
  assertType<['type']>(
    {} as UnionToTuple<
      GetDiscriminator<
        | {
            type: 'a'
            literal: 'a' | 'b'
            prop: number
          }
        | {
            type: 'b'
            literal: 'a' | 'b'
            prop: string
          }
      >
    >,
  )
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

    assertType<
      UnionToTuple<
        | { type: 'A' | null; a: string | null }
        | {
            type: 'B' | null
            b: number | null
          }
        | null
      >
    >({} as UnionToTuple<ReturnType<typeof form.fields.union.$use>['value']>)
    assertType<FormField<'A' | 'B' | null>>({} as ReturnType<typeof form.fields.union.type.$use>)
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

    assertType<FormField<'A' | 'B' | null>>(
      {} as ReturnType<typeof form.fields.string.discriminator.$use>,
    )

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
    assertType<FormFieldAccessor<'a' | 'b' | 'c'>>(
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

  test('multiple discriminators', () => {
    type Data =
      | {
          d1: 'a'
          d2: 'b'
          prop: string
        }
      | {
          d1: 'c'
          d2: 'd'
          prop: number
        }

    assertType<{
      d1: FormFieldAccessor<'a' | 'c'>
      d2: FormFieldAccessor<'b' | 'd'>
      prop: FormFieldAccessor<string> | FormFieldAccessor<number>
    }>({} as BuildFormFieldAccessors<Data>)
  })
})

describe('FormField', () => {
  test('$use() translate option NoInfer', () => {
    const form = useFormCore({
      schema: z.object({
        number: z.number().optional(),
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

  test('key-optional properties', () => {
    assertType<{
      a: FormFieldAccessor<number | null | undefined>
    }>(
      {} as BuildFormFieldAccessors<
        NullableDeep<{
          a?: number | undefined
        }>
      >,
    )
  })
})

describe('events', () => {
  const form = useFormCore({
    schema: z.object({ name: z.string() }),
    sourceValues: { name: '' },
    async submit() {},
  })
  const field = form.fields.name.$use()

  test('listeners receive typed payloads (and form listeners the sender field)', () => {
    form.events.hook('submitted', (payload, sender) => {
      expectTypeOf(payload).toEqualTypeOf<{ id: number }>()
      expectTypeOf(sender).toEqualTypeOf<FormField<unknown>>()
    })
    form.events.hook('ping', (payload) => {
      expectTypeOf(payload).toEqualTypeOf<void>()
    })
    field.events.hook('highlight', (payload) => {
      expectTypeOf(payload).toEqualTypeOf<{ color: string }>()
    })
  })

  test('emitting is allowed only in the correct direction', () => {
    void field.events.callHook('submitted', { id: 1 }) // field -> form
    void field.events.callHook('ping') // void payload
    void form.events.callHook('highlight', { color: 'red' }) // form -> field

    // @ts-expect-error form cannot emit a field -> form event
    void form.events.callHook('submitted', { id: 1 })
    // @ts-expect-error field cannot emit a form -> field event
    void field.events.callHook('highlight', { color: 'red' })
  })

  test('unknown events and wrong payloads are rejected', () => {
    // @ts-expect-error unknown event
    void form.events.callHook('nope')
    // @ts-expect-error wrong payload type
    void form.events.callHook('highlight', { color: 123 })
    // @ts-expect-error missing payload
    void form.events.callHook('highlight')
    // @ts-expect-error void event takes no payload
    void field.events.callHook('ping', {})
  })
})
