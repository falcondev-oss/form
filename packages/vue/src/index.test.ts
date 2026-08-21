import { describe, expect, test, vi } from 'vitest'
import { nextTick, watch } from 'vue'
import z from 'zod'
import { useForm } from '.'

describe('vue', () => {
  test('reactivity', async () => {
    const form = useForm({
      schema: z.object({
        name: z.string(),
      }),
      sourceValues: {
        name: 'John Doe',
      },
      async submit() {},
    })

    const dataWatcher = vi.fn()
    watch(() => form.data.name, dataWatcher)
    const isChangedWatcher = vi.fn()
    watch(() => form.isChanged, isChangedWatcher)

    form.data.name = 'Jane Doe'
    expect(dataWatcher).not.toHaveBeenCalled() // writes are batched until the next flush

    form['~'].flush()
    await nextTick()

    expect(dataWatcher).toHaveBeenCalledOnce()
    expect(dataWatcher.mock.calls[0]?.slice(0, 2)).toEqual(['Jane Doe', 'John Doe'])
    expect(isChangedWatcher.mock.calls[0]?.slice(0, 2)).toEqual([true, false])
  })

  test('model', async () => {
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
    form['~'].flush()
    await nextTick()
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
    watch(() => field.model, modelWatcher)
    watch(() => field.value, valueWatcher)

    field.model = new Date('2002-01-01')
    form['~'].flush()
    await nextTick()

    expect(valueWatcher).toHaveBeenCalledOnce()
    expect(modelWatcher).toHaveBeenCalledOnce()

    expect(form.data.birthday).toEqual('2002-01-01')
    expect(field.value).toEqual(new Date('2002-01-01'))
    expect(field.model).toEqual(new Date('2002-01-01'))
  })
})
