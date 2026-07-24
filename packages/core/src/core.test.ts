import { createEffect, createRoot, createSignal } from '@solidjs/signals'
import { type } from 'arktype'
import { describe, expect, expectTypeOf, test, vi } from 'vitest'
import z from 'zod'
import { useFormCore } from './core'
import { sleep } from './util'

// Async flush convention: writes are microtask-batched, so imperative/test code
// forces the pending batch current via the hidden `form['~'].flush()` escape hatch.
// Validation is async, so error assertions additionally await a macrotask.
const flush = (form: { '~': { flush: () => void } }) => form['~'].flush()
async function settle(form: { '~': { flush: () => void } }) {
  form['~'].flush()
  await sleep(0)
}

describe('form', () => {
  describe('isChanged', () => {
    test('default', () => {
      const form = useFormCore({
        schema: z.object({ name: z.string() }),
        sourceValues: { name: '' },
        async submit() {},
      })

      expect(form.data.name).toBe('')
      expect(form.isChanged).toBe(false)

      form.fields.name.$use().handleChange('Jane Doe')
      flush(form)

      expect(form.data.name).toBe('Jane Doe')
      expect(form.isChanged).toBe(true)
    })

    test('source values with extra properties', () => {
      const form = useFormCore({
        schema: z.object({ name: z.string() }),
        sourceValues: {
          name: 'John Doe',
          id: 1,
        } as { name: string },
        async submit() {},
      })

      expect(form.data.name).toBe('John Doe')
      expect(form.isChanged).toBe(false)

      form.fields.name.$use().handleChange('Jane Doe')
      flush(form)

      expect(form.data.name).toBe('Jane Doe')
      expect(form.isChanged).toBe(true)
    })
  })

  test('data', () => {
    const form = useFormCore({
      schema: z.object({ name: z.string() }),
      sourceValues: { name: 'John Doe' },
      async submit() {},
    })

    expect(form.data.name).toBe('John Doe')

    const spy = vi.fn()
    createRoot(() =>
      createEffect(
        () => form.data.name,
        (value) => void spy(value),
      ),
    )

    form.fields.name.$use().handleChange('Isaac Newton')
    flush(form)
    expect(spy).toHaveBeenCalledWith('Isaac Newton')
  })

  describe('sourceValues', () => {
    test('forbid updates when dirty', () => {
      const [sourceValues, setSourceValues] = createSignal({ name: 'John Doe' })
      const form = useFormCore({
        sourceValues,
        schema: z.object({ name: z.string() }),
        async submit() {},
      })

      form.data.name = 'Jane Doe'
      flush(form)
      expect(form.data.name).toBe('Jane Doe')

      setSourceValues({ name: 'Alice Johnson' })
      flush(form)
      expect(form.data.name).toBe('Jane Doe')
    })

    test('allow updates during submit', async () => {
      const [sourceValues, setSourceValues] = createSignal({ name: 'John Doe' })
      const form = useFormCore({
        sourceValues,
        schema: z.object({ name: z.string() }),
        async submit() {
          setSourceValues({ name: 'Jane Smith' })
        },
      })

      form.data.name = 'Jane Doe'
      flush(form)
      expect(form.data.name).toBe('Jane Doe')

      await form.submit()
      flush(form)
      expect(form.data.name).toBe('Jane Smith')
    })
  })

  test('submit', async () => {
    const form = useFormCore({
      sourceValues: { name: 'John Doe' },
      schema: z.object({ name: z.string() }),
      async submit() {},
    })

    form.data.name = 'Jane Doe'
    flush(form)
    expect(form.isDirty).toBe(true)

    await form.submit()
    expect(form.isDirty).toBe(false)
    expect(form.data.name).toBe('Jane Doe')
  })

  test('arktype delete extra keys', async () => {
    const form = useFormCore({
      schema: type({
        'name': 'string',
        'nested': { age: 'number' },
        '+': 'delete',
      }),
      sourceValues: {
        name: 'John',
        nested: { age: 42 },
        extra: 'This will be deleted',
      },
      async submit({ values }) {
        expect(values).toEqual({ name: 'John', nested: { age: 42 } })
      },
    })

    await expect(form.submit()).resolves.toEqual({ success: true })
  })

  test('arktype mutates validation object', async () => {
    const form = useFormCore({
      schema: type({
        'address': { 'city': 'string', '+': 'delete' },
        '+': 'delete',
      }),
      sourceValues: { address: { city: null } },
      async submit() {},
    })

    form.fields.address.city.$use().handleChange('tiae')
    form.fields.address.city.$use().handleBlur()
    await settle(form)
  })

  test('form disabled state', () => {
    const [disabled, setDisabled] = createSignal(true)

    const form = useFormCore({
      schema: z.object({ name: z.string() }),
      sourceValues: { name: '' },
      disabled,
      async submit() {},
    })

    const field = form.fields.name.$use()
    expect(form.isLoading).toBe(false)
    expect(form.isDisabled).toBe(true)
    expect(field.disabled).toBe(true)

    setDisabled(false)
    flush(form)
    expect(form.isLoading).toBe(false)
    expect(form.isDisabled).toBe(false)
    expect(field.disabled).toBe(false)
  })
})

describe('field', () => {
  test('errors', async () => {
    const form = useFormCore({
      schema: z.object({
        age: z.number(),
        array: z.array(z.object({ name: z.string() })),
      }),
      sourceValues: {
        age: null,
        array: [{ name: null }],
      },
      async submit() {},
    })
    const nestedField = form.fields.array.at(0).name.$use()
    const ageField = form.fields.age.$use()

    expect(nestedField.errors).toBeUndefined()
    expect(ageField.errors).toBeUndefined()

    await form.submit()
    expect(nestedField.errors).toEqual(['Invalid input: expected string, received null'])
    expect(ageField.errors).toEqual(['Invalid input: expected number, received null'])

    // error resets live
    ageField.handleChange(42)
    await settle(form)
    expect(nestedField.errors).toEqual(['Invalid input: expected string, received null'])
    expect(ageField.errors).toBeUndefined()
    expect(form.errors?.length).toBeDefined()

    form.data.array![0]!.name = 'John'
    await settle(form)
    expect(nestedField.errors).toBeUndefined()
    expect(ageField.errors).toBeUndefined()
    expect(form.errors).toBeUndefined()
  })

  test('error resets if no global form errors', async () => {
    const form = useFormCore({
      schema: z.object({ name: z.number().nullable() }),
      sourceValues: { name: null },
      async submit() {},
    })

    const field = form.fields.name.$use()

    field.handleChange('' as never)
    field.handleBlur()
    await settle(form)
    expect(field.errors).toBeDefined()

    field.handleChange(0)
    field.handleBlur()
    await settle(form)
    expect(field.errors).toBeUndefined()
  })

  test('translate', () => {
    const form = useFormCore({
      schema: z.object({ date: z.iso.date() }),
      sourceValues: { date: '2025-01-01' },
      async submit() {},
    })

    const field = form.fields.date.$use()
    const fieldT = form.fields.date.$use({
      translate: {
        get: (v) => (v ? new Date(v) : null),
        set: (v) => v?.toISOString() ?? null,
      },
    })

    expect(field.value).toStrictEqual('2025-01-01')
    expect(fieldT.value).toStrictEqual(new Date('2025-01-01'))

    let now = new Date()
    fieldT.handleChange(now)
    flush(form)

    expect(fieldT.value).toEqual(now)
    expect(field.value).toBe(now.toISOString())
    expect(form.data.date).toBe(now.toISOString())

    now = new Date(+now + 1)
    field.handleChange(now.toISOString())
    flush(form)

    expect(fieldT.value).toEqual(now)
    expect(field.value).toBe(now.toISOString())
    expect(form.data.date).toBe(now.toISOString())
  })

  test('discriminator', async () => {
    const loadedData = {
      union: { type: 'A' as const, value: 'Hello' },
    }
    const [source, setSource] = createSignal<typeof loadedData>()

    const form = useFormCore({
      schema: z.object({
        union: z.discriminatedUnion('type', [
          z.object({ type: z.literal('A'), value: z.string() }),
          z.object({ type: z.literal('B'), value: z.number() }),
        ]),
      }),
      sourceValues: source,
      async submit() {},
    })

    const unionField = form.fields.union.$use({ discriminator: 'type' })

    expect(unionField.type).toBeNull()
    expect(unionField.$field.$use().value).toEqual(null)
    if (unionField.type === null) {
      expectTypeOf(unionField.$field.$use().value).toEqualTypeOf<
        | { type: 'A' | null; value: string | null }
        | { type: 'B' | null; value: number | null }
        | null
      >()
    }
    setSource(loadedData)
    flush(form)

    expect('type' in unionField.$field).toBe(true)
    expect('notFound' in unionField.$field).toBe(false)

    expect(unionField.$field.$use().value).toEqual({ type: 'A', value: 'Hello' })
    if (unionField.type === 'A') {
      expectTypeOf(unionField.$field.$use().value).toEqualTypeOf<{
        type: 'A' | null
        value: string | null
      } | null>()
    }

    if (form.data) form.data.union = { type: 'B', value: 42 }
    flush(form)
    expect(unionField.$field.$use().value).toEqual({ type: 'B', value: 42 })
    if (unionField.type === 'B') {
      expectTypeOf(unionField.$field.$use().value).toEqualTypeOf<{
        type: 'B' | null
        value: number | null
      } | null>()
    }
  })

  test('sourceValues is undefined', async () => {
    const [isLoading, setLoading] = createSignal(true)

    const form = useFormCore({
      schema: z.object({ person: z.object({ name: z.string() }) }),
      sourceValues() {
        if (isLoading()) return
        return { person: { name: 'John Doe' } }
      },
      async submit() {
        await sleep(20)
        return { success: true }
      },
    })

    const nameField = form.fields.person.name.$use()
    expect(nameField.isPending).toBe(true)
    expect(form.isLoading).toBe(true)
    expect(form.data?.person).toBeUndefined()
    expect(nameField.value).toBeNull()

    nameField.handleChange('Input is ignored')
    flush(form)
    expect(nameField.value).toBeNull()

    setLoading(false)
    flush(form)
    expect(nameField.isPending).toBe(false)
    expect(form.isLoading).toBe(false)

    expect(nameField.value).toBe('John Doe')
    expect(form.data?.person?.name).toBe('John Doe')

    const submit = form.submit()

    await sleep(0)
    expect(form.isLoading).toBe(true)
    expect(nameField.isPending).toBe(false) // pending is only for loading source values

    await submit

    expect(form.isLoading).toBe(false)
    expect(nameField.isPending).toBe(false)
  })

  describe('accessor', () => {
    test('dot in object key', () => {
      const form = useFormCore({
        schema: z.object({
          'foo.bar': z.string(),
          'foo.bar.array': z.array(z.string()),
        }),
        sourceValues: () => ({
          'foo.bar': null,
          'foo.bar.array': ['one', 'two'],
        }),
        async submit() {},
      })

      const stringField = form.fields['foo.bar'].$use()
      expect(stringField.value).toBeNull()

      stringField.handleChange('Test')
      flush(form)

      expect(stringField.value).toBe('Test')
      expect(form.data['foo.bar']).toBe('Test')
      expect(stringField.path).toBe(String.raw`foo\.bar`)

      const arrayField = form.fields['foo.bar.array'].at(0).$use()
      expect(arrayField.value).toBe('one')
      expect(form.data['foo.bar.array']?.[0]).toEqual('one')

      form.data['foo.bar.array']?.unshift('zero')
      flush(form)

      expect(form.data['foo.bar.array']?.[0]).toEqual('zero')
      expect(arrayField.value).toBe('zero')
    })

    test('array value without array itself', () => {
      const form = useFormCore({
        schema: z.object({ array: z.array(z.string()) }),
        sourceValues: () => ({ array: ['one', 'two'] }),
        async submit() {},
      })

      const arrayField = form.fields.array.at(0).$use()
      expect(arrayField.value).toBe('one')
      expect(form.data.array?.[0]).toEqual('one')

      form.data.array?.unshift('zero')
      flush(form)

      expect(form.data.array?.[0]).toEqual('zero')
      expect(arrayField.value).toBe('zero')
    })

    test('root value', () => {
      const form = useFormCore({
        schema: z.object({ name: z.string() }),
        sourceValues: () => ({ name: 'John' }),
        async submit() {},
      })

      expect(form.fields.$use().value.name).toEqual('John')
      expect(form.fields.name.$use().value).toEqual('John')
    })
  })

  test('readonly', () => {
    const form = useFormCore({
      schema: z.object({
        a: z.string().optional(),
        array: z.array(z.string()),
        obj: z.object({ b: z.number() }),
      }),
      sourceValues: {
        a: 'initial',
        array: ['one', 'two'],
        obj: { b: 123 },
      },
      async submit() {},
    })

    const consoleWarnSpy = vi.spyOn(console, 'warn')

    // whole-value reassignment is blocked (field.value is readonly)
    // @ts-expect-error Prevent assignment to readonly property
    form.fields.$use().value = {}
    expect(consoleWarnSpy).toHaveBeenLastCalledWith(
      'useForm:',
      'field.value is readonly, use handleChange() instead',
    )

    // nested writes flow through to form.data
    form.fields.$use().value.a = 'new value'
    form.fields.$use().value.obj!.b = 456
    form.fields.array.$use().value?.push('three')
    flush(form)

    expect(form.data.a).toBe('new value')
    expect(form.data.obj?.b).toBe(456)
    expect(form.data.array).toEqual(['one', 'two', 'three'])
  })
})

describe('identity', () => {
  test('object array reorder keeps field identity (key, dirty, value follow the datum)', () => {
    const form = useFormCore({
      schema: z.object({ items: z.array(z.object({ a: z.string() })) }),
      sourceValues: { items: [{ a: 'x' }, { a: 'y' }, { a: 'z' }] },
      async submit() {},
    })

    const a0 = form.fields.items.at(0).a.$use()
    const key0 = a0.key
    expect(a0.value).toBe('x')

    a0.handleChange('X')
    flush(form)
    expect(a0.value).toBe('X')
    expect(a0.isDirty).toBe(true)

    // move items[0] to the end
    form.setData((d) => {
      const [moved] = d.items!.splice(0, 1)
      d.items!.push(moved!)
    })
    flush(form)

    // items are now [{a:'y'},{a:'z'},{a:'X'}] — the field rode along to index 2
    const moved = form.fields.items.at(2).a.$use()
    expect(moved.key).toBe(key0)
    expect(moved.isDirty).toBe(true)
    expect(moved.value).toBe('X')

    // the original handle now reports the new index
    expect(a0.value).toBe('X')
    expect(a0.path).toBe('items[2].a')
  })

  test('splice/insert keeps existing elements’ identity', () => {
    const form = useFormCore({
      schema: z.object({ items: z.array(z.object({ a: z.string() })) }),
      sourceValues: { items: [{ a: 'x' }, { a: 'y' }] },
      async submit() {},
    })

    const last = form.fields.items.at(1).$use()
    const lastKey = last.key

    // insert a fresh element at the front
    form.setData((d) => {
      d.items!.splice(0, 0, { a: 'new' })
    })
    flush(form)

    // existing element kept its field; only the new one is fresh
    expect(form.fields.items.at(2).$use().key).toBe(lastKey)
    expect(form.fields.items.at(0).$use().key).not.toBe(lastKey)
    expect(last.path).toBe('items[2]')
  })

  test('sort reorders data and fields by value', () => {
    const form = useFormCore({
      schema: z.object({ items: z.array(z.object({ a: z.string() })) }),
      sourceValues: { items: [{ a: 'c' }, { a: 'a' }, { a: 'b' }] },
      async submit() {},
    })

    const cField = form.fields.items.at(0).$use()
    const cKey = cField.key

    form.data.items!.sort((l, r) => (l!.a ?? '').localeCompare(r!.a ?? ''))
    flush(form)

    expect(form.data.items?.map((i) => i?.a)).toEqual(['a', 'b', 'c'])
    // the {a:'c'} element moved to index 2, its field went with it
    expect(form.fields.items.at(2).$use().key).toBe(cKey)
  })

  test('primitive array reorder is positional (accepted)', () => {
    const form = useFormCore({
      schema: z.object({ tags: z.array(z.string()) }),
      sourceValues: { tags: ['a', 'b', 'c'] },
      async submit() {},
    })

    const t0 = form.fields.tags.at(0).$use()
    const t0key = t0.key
    t0.handleChange('A')
    flush(form)
    expect(t0.value).toBe('A')
    expect(t0.isDirty).toBe(true)

    form.setData((d) => {
      const [moved] = d.tags!.splice(0, 1)
      d.tags!.push(moved!)
    })
    flush(form)

    // index 0 keeps its field (positional) — value is now the new occupant
    const at0 = form.fields.tags.at(0).$use()
    expect(at0.key).toBe(t0key)
    expect(at0.value).toBe('b')
    expect(at0.isDirty).toBe(true)
  })

  test('delete(key) removes the correct element by identity after a reorder', () => {
    const form = useFormCore({
      schema: z.object({ items: z.array(z.object({ a: z.string() })) }),
      sourceValues: { items: [{ a: 'x' }, { a: 'y' }, { a: 'z' }] },
      async submit() {},
    })

    const first = form.fields.items.at(0).$use()
    const firstKey = first.key

    form.setData((d) => {
      const [moved] = d.items!.splice(0, 1)
      d.items!.push(moved!)
    })
    flush(form)
    // items: [{a:'y'},{a:'z'},{a:'x'}] — firstKey now points at index 2

    form.fields.items.delete(firstKey)
    flush(form)
    expect(form.data.items).toEqual([{ a: 'y' }, { a: 'z' }])
  })

  test('setData applies a batch atomically with a single validation', async () => {
    const form = useFormCore({
      schema: z.object({ a: z.string(), b: z.string() }),
      sourceValues: { a: null, b: null },
      async submit() {},
    })

    await form.submit() // invalid → surfaces errors
    expect(form.errors?.length).toBe(2)

    const afterValidate = vi.fn()
    form.hooks.hook('afterValidate', afterValidate)

    form.setData((d) => {
      d.a = 'A'
      d.b = 'B'
    })
    await settle(form)

    expect(form.data.a).toBe('A')
    expect(form.data.b).toBe('B')
    expect(afterValidate).toHaveBeenCalledTimes(1) // one validation for the batch
    expect(form.errors).toBeUndefined()
  })

  test('reset restores source and keeps fields stable positionally', () => {
    const form = useFormCore({
      schema: z.object({ items: z.array(z.object({ a: z.string() })) }),
      sourceValues: { items: [{ a: 'x' }, { a: 'y' }] },
      async submit() {},
    })

    const a0 = form.fields.items.at(0).a.$use()
    a0.handleChange('X')
    flush(form)
    expect(a0.isDirty).toBe(true)

    form.reset()
    flush(form)

    expect(a0.value).toBe('x')
    expect(a0.isDirty).toBe(false)
    expect(form.isDirty).toBe(false)
    // positional reconcile keeps the node, so the same field is reused
    expect(form.fields.items.at(0).a.$use().key).toBe(a0.key)
  })

  test('key resolver preserves identity across an id-keyed source refresh', () => {
    const [source, setSource] = createSignal({
      items: [
        { id: 1, a: 'x' },
        { id: 2, a: 'y' },
      ],
    })
    const form = useFormCore({
      schema: z.object({ items: z.array(z.object({ id: z.number(), a: z.string() })) }),
      sourceValues: source,
      reconcileKey: 'id',
      async submit() {},
    })

    const item2 = form.fields.items.at(1).$use()
    const key2 = item2.key

    // server refresh: id:2 comes back first (reordered) with new data
    setSource({
      items: [
        { id: 2, a: 'Y' },
        { id: 1, a: 'X' },
      ],
    })
    flush(form)

    const atFront = form.fields.items.at(0).$use()
    expect(atFront.key).toBe(key2) // identity preserved by id across reorder
    expect(form.data.items?.map((i) => i?.a)).toEqual(['Y', 'X'])
  })
})

describe('hooks', () => {
  test('beforeSubmit, afterSubmit', async () => {
    const beforeSubmitSpy = vi.fn()
    const afterSubmitSpy = vi.fn()

    const form = useFormCore({
      schema: z.object({ name: z.string() }),
      sourceValues: { name: 'John' },
      hooks: { beforeSubmit: beforeSubmitSpy, afterSubmit: afterSubmitSpy },
      async submit({ values }) {
        expect(values).toEqual({ name: 'John' })
      },
    })

    let result = await form.submit()

    expect(result.success).toBe(true)
    expect(beforeSubmitSpy).toHaveBeenCalledWith({ data: { name: 'John' } })
    expect(afterSubmitSpy).toHaveBeenCalledWith({ success: true })
    expect(beforeSubmitSpy).toHaveBeenCalledBefore(afterSubmitSpy)

    // @ts-expect-error test validation
    form.data.name = 2
    flush(form)

    result = await form.submit()

    expect(result.success).toBe(false)
    expect(beforeSubmitSpy).toHaveBeenNthCalledWith(2, { data: { name: 2 } })
    expect(afterSubmitSpy).toHaveBeenNthCalledWith(2, { success: false })
  })

  test('beforeValidate, afterValidate', async () => {
    const beforeValidateSpy = vi.fn()
    const afterValidateSpy = vi.fn()

    const form = useFormCore({
      schema: z.object({ name: z.string() }),
      sourceValues: { name: 'John' },
      hooks: { beforeValidate: beforeValidateSpy, afterValidate: afterValidateSpy },
      async submit() {},
    })

    await form.submit()

    expect(beforeValidateSpy).toHaveBeenCalled()
    expect(afterValidateSpy).toHaveBeenCalledWith({ value: { name: 'John' } })
    expect(beforeValidateSpy).toHaveBeenCalledBefore(afterValidateSpy)
  })

  test('beforeFieldChange, afterFieldChange', async () => {
    const beforeFieldChangeSpy = vi.fn()
    const afterFieldChangeSpy = vi.fn()

    const form = useFormCore({
      schema: z.object({ name: z.string() }),
      sourceValues: { name: 'John' },
      hooks: { beforeFieldChange: beforeFieldChangeSpy, afterFieldChange: afterFieldChangeSpy },
      async submit() {},
    })

    const field = form.fields.name.$use()
    field.handleChange('Jane')

    await sleep(100)

    expect(beforeFieldChangeSpy).toHaveBeenCalledWith(field, 'Jane')
    expect(afterFieldChangeSpy).toHaveBeenCalledWith(field, 'Jane')
    expect(beforeFieldChangeSpy).toHaveBeenCalledBefore(afterFieldChangeSpy)
  })

  test('async hook order', async () => {
    const hookOrder: string[] = []

    const form = useFormCore({
      schema: z.object({ name: z.string() }),
      sourceValues: { name: 'John' },
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

  test('arrays', () => {
    const form = useFormCore({
      schema: z.object({
        items: z.array(z.object({ a: z.string(), b: z.number() })),
      }),
      sourceValues: { items: [] },
      async submit() {},
    })

    const a2 = form.fields.items.at(2)?.a.$use()
    const a2PrevKey = a2.key

    expect(a2.value).toBeNull()
    expect(form.data.items).toEqual([])

    const items = form.fields.items.$use()
    items.handleChange([
      { a: '1', b: 1 },
      { a: '2', b: 2 },
      { a: '3', b: 3 },
    ])
    flush(form)
    expect(a2.value).toBe('3')

    // items[2] is now a real node, so a fresh $use resolves to a new field
    expect(form.fields.items.at(2)?.a.$use().key).not.toBe(a2PrevKey)

    expect(form.data.items).toEqual([
      { a: '1', b: 1 },
      { a: '2', b: 2 },
      { a: '3', b: 3 },
    ])

    expect(() => form.fields.items.delete(form.fields.items.at(2).a.$use().key)).toThrow(
      'Key does not reference an array item',
    )

    form.fields.items.delete(form.fields.items.at(2).$use().key)
    flush(form)
    expect(form.data.items).toEqual([
      { a: '1', b: 1 },
      { a: '2', b: 2 },
    ])
  })
})
