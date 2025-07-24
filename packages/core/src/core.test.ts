import { describe, expect, test } from 'vitest'
import z from 'zod'
import { useFormCore } from './core'

describe('form', () => {
  describe('isChanged', () => {
    test('default', () => {
      const form = useFormCore({
        schema: z.object({
          name: z.string(),
        }),
        sourceValues: {
          name: '',
        },
        async submit() {},
      })

      expect(form.data.name).toBe('')
      expect(form.isChanged.value).toBe(false)

      form.fields.name.$use().handleChange('Jane Doe')

      expect(form.data.name).toBe('Jane Doe')
      expect(form.isChanged.value).toBe(true)
    })

    test('source values with extra properties', () => {
      const form = useFormCore({
        schema: z.object({
          name: z.string(),
        }),
        sourceValues: {
          name: 'John Doe',
          // Extra property that should not affect isChanged
          id: 1,
        } as { name: string },
        async submit() {},
      })

      expect(form.data.name).toBe('John Doe')
      expect(form.isChanged.value).toBe(false)

      form.fields.name.$use().handleChange('Jane Doe')

      expect(form.data.name).toBe('Jane Doe')
      expect(form.isChanged.value).toBe(true)
    })
  })
})

describe('field', () => {
  test('errors', async () => {
    const form = useFormCore({
      schema: z.object({
        age: z.number(),
        array: z.array(
          z.object({
            name: z.string(),
          }),
        ),
      }),
      sourceValues: {
        age: null,
        array: [
          {
            name: null,
          },
        ],
      },
      async submit() {},
    })
    const nestedField = form.fields.array.at(0)!.name.$use()
    const ageField = form.fields.age.$use()

    expect(nestedField.errors.value).toEqual(undefined)
    expect(ageField.errors.value).toEqual(undefined)

    await form.submit()
    expect(nestedField.errors.value).toEqual(['Invalid input: expected string, received null'])
    expect(ageField.errors.value).toEqual(['Invalid input: expected number, received null'])
  })
})
