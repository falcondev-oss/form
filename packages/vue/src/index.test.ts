import { describe, expect, test, vi } from 'vitest'
import { isReactive, watch } from 'vue'
import z from 'zod'
import { useForm } from '.'

describe('vue', () => {
  test('reactivity', () => {
    const form = useForm({
      schema: z.object({
        name: z.string(),
      }),
      sourceValues: {
        name: 'John Doe',
      },
      async submit() {},
    })

    expect(isReactive(form)).toBe(true)

    const dataWatcher = vi.fn()
    watch(() => form.data.name, dataWatcher, { flush: 'sync' })
    const isChangedWatcher = vi.fn()
    watch(() => form.isChanged, isChangedWatcher, { flush: 'sync' })

    form.data.name = 'Jane Doe'

    expect(dataWatcher).toHaveBeenCalledOnce()
    expect(isChangedWatcher).toHaveBeenCalledOnce()
  })

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

  test('model returns raw host objects (File)', () => {
    const form = useForm({
      schema: z.object({
        file: z.instanceof(File).nullable(),
      }),
      sourceValues: {
        file: null,
      },
      async submit() {},
    })

    const file = new File(['hello'], 'greeting.txt', { type: 'text/plain' })
    const field = form.fields.file.$use()
    field.model = file

    // model must expose the raw File with working native getters, not a proxy
    expect(field.model).toBe(file)
    expect(field.model?.name).toBe('greeting.txt')
    expect(field.model?.size).toBe(5)
    expect(form.data.file).toBe(file)
    expect(form.data.file?.type).toBe('text/plain')
  })
})
