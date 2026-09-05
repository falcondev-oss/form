import { describe, expect, test, vi } from 'vitest'
import { computed, effectScope, nextTick, ref, watch } from 'vue'
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

    const dataWatcher = vi.fn()
    watch(() => form.data.name, dataWatcher, { flush: 'sync' })
    const isChangedWatcher = vi.fn()
    watch(() => form.isChanged, isChangedWatcher, { flush: 'sync' })

    form.data.name = 'Jane Doe'
    form['~'].flush()

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
    form['~'].flush()
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
    form['~'].flush()

    expect(valueWatcher).toHaveBeenCalledOnce()
    expect(modelWatcher).toHaveBeenCalledOnce()

    expect(form.data.birthday).toEqual('2002-01-01')
    expect(field.value).toEqual(new Date('2002-01-01'))
    expect(field.model).toEqual(new Date('2002-01-01'))
  })
})

test('Vue source refs, disabled refs and scope disposal bridge to the store', async () => {
  const sourceValues = ref({ name: 'John' })
  const disabled = ref(false)
  const scope = effectScope()
  const form = scope.run(() =>
    useForm({ schema: z.object({ name: z.string() }), sourceValues, disabled, async submit() {} }),
  )!
  const name = computed(() => form.fields.name.$use().model)
  sourceValues.value.name = 'Jane'
  await nextTick()
  form['~'].flush()
  expect(name.value).toBe('Jane')
  disabled.value = true
  await nextTick()
  form['~'].flush()
  form.fields.name.$use().model = 'blocked'
  form['~'].flush()
  expect(name.value).toBe('Jane')
  scope.stop()
  sourceValues.value.name = 'after disposal'
  await nextTick()
  form['~'].flush()
  expect(form.data.name).toBe('Jane')
})
