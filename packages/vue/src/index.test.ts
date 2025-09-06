import { describe, expect, test, vi } from 'vitest'
import { watch } from 'vue'
import z from 'zod'
import { useForm } from '.'

describe('vue', () => {
  test('model', () => {
    const form = useForm({
      schema: z.object({
        name: z.string(),
        birthday: z.iso.date(),
      }),
      sourceValues: {
        name: 'John Doe',
        birthday: '2000-01-01',
      },
      async submit() {},
    })

    expect(form.fields.name.$use().model).toEqual('John Doe')
    form.fields.name.$use().model = 'Jane Doe'
    expect(form.fields.name.$use().model).toEqual('Jane Doe')
    expect(form.data.name).toEqual('Jane Doe')

    const field = form.fields.birthday.$use({
      translate: {
        get: (v) => (v && new Date(v)) || null,
        set: (v) => v?.toISOString().split('T')[0] ?? null,
      },
    })

    const modelWatcher = vi.fn()
    const valueWatcher = vi.fn()
    watch(() => field.model, modelWatcher, { flush: 'sync' })
    watch(() => field.value, valueWatcher, { flush: 'sync' })

    field.model = new Date('2002-01-01')

    expect(valueWatcher).toHaveBeenCalledOnce()
    expect(modelWatcher).toHaveBeenCalledOnce()

    expect(form.data.birthday).toEqual('2002-01-01')
    expect(field.value).toEqual(new Date('2002-01-01'))
    expect(field.model).toEqual(new Date('2002-01-01'))
  })
})
