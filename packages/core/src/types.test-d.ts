import type { NullableDeep } from './types'
import { assertType, test } from 'vitest'

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
