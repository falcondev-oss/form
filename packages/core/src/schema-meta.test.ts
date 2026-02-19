import { describe, expect, test } from 'vitest'
import z from 'zod'
import { useFormCore } from './core'

describe('getSchemaMeta', () => {
  test('nested string field', () => {
    const form = useFormCore({
      schema: z.object({
        nested: z.object({ name: z.string().min(1).meta({ title: 'Name' }) }),
      }),
      sourceValues: () => ({ nested: { name: 'hello' } }),
      submit: async () => {},
    })

    const field = form.fields.nested.name.$use()
    expect(field.schema.required).toBe(true)
    expect(field.schema.title).toBe('Name')
    expect(field.schema.minLength).toBe(1)
  })

  test('optional/nullable field', () => {
    const form = useFormCore({
      schema: z.object({
        optional: z.string().optional(),
        nullable: z.string().nullable(),
        required: z.string(),
      }),
      sourceValues: () => ({ nullable: null, optional: undefined, required: 'value' }),
      submit: async () => {},
    })

    const optionalField = form.fields.optional.$use()
    expect(optionalField.schema.required).toBe(false)
    const nullableField = form.fields.nullable.$use()
    expect(nullableField.schema.required).toBe(false)
    const requiredField = form.fields.required.$use()
    expect(requiredField.schema.required).toBe(true)
  })

  test('numeric constraints', () => {
    const form = useFormCore({
      schema: z.object({ age: z.number().min(0).max(150).meta({ title: 'Age' }) }),
      sourceValues: () => ({ age: 25 }),
      submit: async () => {},
    })

    const field = form.fields.age.$use()
    expect(field.schema.required).toBe(true)
    expect(field.schema.minimum).toBe(0)
    expect(field.schema.maximum).toBe(150)
    expect(field.schema.title).toBe('Age')
  })

  test('array item field', () => {
    const form = useFormCore({
      schema: z.object({ items: z.array(z.object({ name: z.string().max(100) })) }),
      sourceValues: () => ({ items: [{ name: 'first' }] }),
      submit: async () => {},
    })

    const field = form.fields.items.at(0).name.$use()
    expect(field.schema.required).toBe(true)
    expect(field.schema.maxLength).toBe(100)
  })

  test('default and examples', () => {
    const form = useFormCore({
      schema: z.object({
        color: z
          .string()
          .optional()
          .default('blue')
          .meta({ examples: ['red', 'green', 'blue'] }),
      }),
      sourceValues: () => ({ color: null }),
      submit: async () => {},
    })

    const field = form.fields.color.$use()
    expect(field.schema.default).toBe('blue')
    expect(field.schema.required).toBe(false)
    expect(field.schema.examples).toEqual(['red', 'green', 'blue'])
  })

  test('exclusive min/max', () => {
    const form = useFormCore({
      schema: z.object({ score: z.number().gt(0).lt(100).nullable().meta({ title: 'Score' }) }),
      sourceValues: () => ({ score: 50 }),
      submit: async () => {},
    })

    const field = form.fields.score.$use()
    expect(field.schema.required).toBe(false)
    expect(field.schema.exclusiveMinimum).toBe(0)
    expect(field.schema.exclusiveMaximum).toBe(100)
  })

  test('union of string with maxLength and number with min', () => {
    const schema = z.object({ value: z.union([z.string().max(50), z.number().min(10)]) })

    const form = useFormCore({
      schema,
      sourceValues: () => ({ value: 'hello' }),
      submit: async () => {},
    })
    const field = form.fields.value.$use()
    expect(field.schema.required).toBe(true)
    expect(field.schema.maxLength).toBe(50)

    form.data.value = 5

    expect(field.schema.required).toBe(true)
    expect(field.schema.minimum).toBe(10)
  })
})
