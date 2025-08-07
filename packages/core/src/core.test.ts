import { watch } from '@vue/reactivity'
import { describe, expect, test, vi } from 'vitest'
import z from 'zod'
import { useFormCore } from './core'
import { sleep } from './helpers'

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

  test('data', () => {
    const form = useFormCore({
      schema: z.object({
        name: z.string(),
      }),
      sourceValues: {
        name: 'John Doe',
      },
      async submit() {},
    })

    expect(form.data.name).toBe('John Doe')

    const spy = vi.fn()

    watch(
      () => form.data.name,
      (value) => void spy(value),
    )

    form.fields.name.$use().handleChange('Isaac Newton')
    expect(spy).toHaveBeenCalledWith('Isaac Newton')
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

    expect(nestedField.errors).toEqual(undefined)
    expect(ageField.errors).toEqual(undefined)

    await form.submit()
    expect(nestedField.errors).toEqual(['Invalid input: expected string, received null'])
    expect(ageField.errors).toEqual(['Invalid input: expected number, received null'])
  })

  test('translate', async () => {
    const form = useFormCore({
      schema: z.object({
        date: z.iso.date(),
      }),
      sourceValues: {
        date: '2025-01-01',
      },
      async submit() {},
    })

    const field = form.fields.date.$use({
      translate: {
        get: (v) => (v ? new Date(v) : null),
        set: (v) => v?.toISOString() ?? null,
      },
    })

    expect(field.value).toStrictEqual(new Date('2025-01-01'))

    const now = new Date()
    field.handleChange(now)

    expect(field.value).toBe(now)
    expect(form.data.date).toBe(now.toISOString())
  })
})

describe('hooks', () => {
  test('beforeSubmit, afterSubmit', async () => {
    const beforeSubmitSpy = vi.fn()
    const afterSubmitSpy = vi.fn()

    const form = useFormCore({
      schema: z.object({
        name: z.string(),
      }),
      sourceValues: {
        name: 'John',
      },
      hooks: {
        beforeSubmit: beforeSubmitSpy,
        afterSubmit: afterSubmitSpy,
      },
      async submit({ values }) {
        expect(values).toEqual({ name: 'John' })
        return { success: true }
      },
    })

    const result = await form.submit()

    expect(result.success).toBe(true)
    expect(beforeSubmitSpy).toHaveBeenCalledWith({ values: { name: 'John' } })
    expect(afterSubmitSpy).toHaveBeenCalledWith({ success: true })
    expect(beforeSubmitSpy).toHaveBeenCalledBefore(afterSubmitSpy)
  })

  // test('beforeReset, afterReset', () => {
  //   const beforeResetSpy = vi.fn()
  //   const afterResetSpy = vi.fn()

  //   const form = useFormCore({
  //     schema: z.object({
  //       name: z.string(),
  //     }),
  //     sourceValues: {
  //       name: 'John',
  //     },
  //     hooks: {
  //       beforeReset: beforeResetSpy,
  //       afterReset: afterResetSpy,
  //     },
  //     async submit() {},
  //   })

  //   form.fields.name.$use().handleChange('Jane')
  //   expect(form.data.name).toBe('Jane')

  //   form.reset()

  //   expect(form.data.name).toBe('John')
  //   expect(beforeResetSpy).toHaveBeenCalled()
  //   expect(afterResetSpy).toHaveBeenCalled()
  //   expect(beforeResetSpy).toHaveBeenCalledBefore(afterResetSpy)
  // })

  test('beforeValidate, afterValidate', async () => {
    const beforeValidateSpy = vi.fn()
    const afterValidateSpy = vi.fn()

    const form = useFormCore({
      schema: z.object({
        name: z.string(),
      }),
      sourceValues: {
        name: 'John',
      },
      hooks: {
        beforeValidate: beforeValidateSpy,
        afterValidate: afterValidateSpy,
      },
      async submit() {},
    })

    await form.submit()

    expect(beforeValidateSpy).toHaveBeenCalled()
    expect(afterValidateSpy).toHaveBeenCalledWith({ value: { name: 'John' } })
    expect(beforeValidateSpy).toHaveBeenCalledBefore(afterValidateSpy)
  })

  // test('beforeFieldChange, afterFieldChange', () => {
  //   const beforeFieldChangeSpy = vi.fn()
  //   const afterFieldChangeSpy = vi.fn()

  //   const form = useFormCore({
  //     schema: z.object({
  //       name: z.string(),
  //     }),
  //     sourceValues: {
  //       name: 'John',
  //     },
  //     hooks: {
  //       beforeFieldChange: beforeFieldChangeSpy,
  //       afterFieldChange: afterFieldChangeSpy,
  //     },
  //     async submit() {},
  //   })

  //   const field = form.fields.name.$use()
  //   field.handleChange('Jane')

  //   expect(beforeFieldChangeSpy).toHaveBeenCalledWith(field, 'Jane')
  //   expect(afterFieldChangeSpy).toHaveBeenCalledWith(field, 'Jane')
  //   expect(beforeFieldChangeSpy).toHaveBeenCalledBefore(afterFieldChangeSpy)
  // })

  // test('beforeFieldReset, afterFieldReset', () => {
  //   const beforeFieldResetSpy = vi.fn()
  //   const afterFieldResetSpy = vi.fn()

  //   const form = useFormCore({
  //     schema: z.object({
  //       name: z.string(),
  //     }),
  //     sourceValues: {
  //       name: 'John',
  //     },
  //     hooks: {
  //       beforeFieldReset: beforeFieldResetSpy,
  //       afterFieldReset: afterFieldResetSpy,
  //     },
  //     async submit() {},
  //   })

  //   const field = form.fields.name.$use()
  //   field.handleChange('Jane')
  //   field.reset()

  //   expect(beforeFieldResetSpy).toHaveBeenCalled()
  //   expect(afterFieldResetSpy).toHaveBeenCalled()
  //   expect(beforeFieldResetSpy).toHaveBeenCalledBefore(afterFieldResetSpy)
  // })

  test('async hook order', async () => {
    const hookOrder: string[] = []

    const form = useFormCore({
      schema: z.object({
        name: z.string(),
      }),
      sourceValues: {
        name: 'John',
      },
      hooks: {
        beforeSubmit: async () => {
          await sleep(10)
          hookOrder.push('beforeSubmit')
        },
        afterSubmit: async () => {
          await sleep(5)
          hookOrder.push('afterSubmit')
        },
      },
      async submit() {
        hookOrder.push('submit')
        return { success: true }
      },
    })

    await form.submit()

    expect(hookOrder).toEqual(['beforeSubmit', 'submit', 'afterSubmit'])
  })
})
