import { describe, expect, test, vi } from 'vitest'
import { computed, isReactive, ref, watch } from 'vue'
import z from 'zod'
import { useForm, useFormHandles } from '.'

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

  test('vue refs as options', () => {
    const isLoading = ref(true)
    const disabled = ref(true)
    const form = useForm({
      schema: z.object({ name: z.string() }),
      sourceValues: () => (isLoading.value ? undefined : { name: 'John' }),
      disabled,
      async submit() {},
    })

    const isLoadingWatcher = vi.fn()
    watch(() => form.isLoading, isLoadingWatcher, { flush: 'sync' })
    expect(form.isLoading).toBe(true)
    expect(form.data).toBeUndefined()

    isLoading.value = false
    expect(isLoadingWatcher).toHaveBeenCalledOnce()
    expect(form.data?.name).toBe('John')
    expect(form.isDisabled).toBe(true)

    disabled.value = false
    expect(form.isDisabled).toBe(false)
  })

  test('computed over fields, data and discriminated unions', () => {
    const form = useForm({
      schema: z.object({
        items: z.array(z.string()),
        union: z.discriminatedUnion('type', [
          z.object({ type: z.literal('A'), value: z.string() }),
          z.object({ type: z.literal('B'), value: z.number() }),
        ]),
      }),
      sourceValues: { items: ['a'], union: { type: 'A' as const, value: 'x' } },
      async submit() {},
    })

    const count = computed(() => [...form.fields.items].length)
    const joined = computed(() => form.data.items?.join(','))
    const union = form.fields.union.$use({ discriminator: 'type' })
    const label = computed(() =>
      union.type === 'A' ? union.$field.value.$use().value : union.type,
    )

    expect([count.value, joined.value, label.value]).toEqual([1, 'a', 'x'])

    form.data.items!.push('b')
    expect([count.value, joined.value]).toEqual([2, 'a,b'])

    if (union.type === 'A') union.$field.value.$use().handleChange('y')
    expect(label.value).toBe('y')

    form.data.union = { type: 'B', value: 1 }
    expect(label.value).toBe('B')
  })

  test('useFormHandles', async () => {
    const options = {
      schema: z.object({ name: z.string() }),
      sourceValues: { name: 'John' },
      submit: vi.fn(async () => {}),
    }
    const a = useForm(options)
    const b = useForm(options)
    const combined = useFormHandles(() => [a, b])

    expect(combined.isDirty).toBe(false)
    b.fields.name.$use().model = 'Jane'
    expect(combined.isDirty).toBe(true)

    await combined.submit()
    expect(options.submit).toHaveBeenCalledTimes(2)
    expect(combined.isDirty).toBe(false)
  })
})
