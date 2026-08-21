import { type } from 'arktype'
import { describe, expect, expectTypeOf, test, vi } from 'vitest'
import z from 'zod'
import { useFormCore } from './core'
import { sleep } from './util'

function flush(form: { '~': { flush: () => void } }) {
  form['~'].flush()
}

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
      expect(form.isChanged).toBe(false)

      form.fields.name.$use().handleChange('Jane Doe')
      flush(form)

      expect(form.data.name).toBe('Jane Doe')
      expect(form.isChanged).toBe(true)
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
      expect(form.isChanged).toBe(false)

      form.fields.name.$use().handleChange('Jane Doe')
      flush(form)

      expect(form.data.name).toBe('Jane Doe')
      expect(form.isChanged).toBe(true)
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

    form.fields.name.$use().handleChange('Isaac Newton')
    expect(form.data.name).toBe('John Doe') // writes are batched until the next flush

    flush(form)
    expect(form.data.name).toBe('Isaac Newton')
  })

  describe('sourceValues', () => {
    test('forbid updates when dirty', () => {
      let sourceValues: { name: string } = { name: 'John Doe' }
      const consoleWarnSpy = vi.spyOn(console, 'warn')

      const form = useFormCore({
        sourceValues: () => sourceValues,
        schema: z.object({
          name: z.string(),
        }),
        async submit() {},
      })

      form.data.name = 'Jane Doe'
      flush(form)
      expect(form.data.name).toBe('Jane Doe')

      sourceValues = { name: 'Alice Johnson' }
      form['~'].refresh()
      expect(form.data.name).toBe('Jane Doe')
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'useForm:',
        'Skipped sourceValues update after form was edited',
      )
    })

    test('allow updates during submit', async () => {
      let sourceValues: { name: string } = { name: 'John Doe' }
      const form = useFormCore({
        sourceValues: () => sourceValues,
        schema: z.object({
          name: z.string(),
        }),
        async submit() {
          sourceValues = { name: 'Jane Smith' }
          form['~'].refresh()
        },
      })

      // make form dirty
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
      sourceValues: {
        name: 'John Doe',
      },
      schema: z.object({
        name: z.string(),
      }),
      async submit() {},
    })

    form.data.name = 'Jane Doe'
    flush(form)
    expect(form.isDirty).toBe(true)

    await form.submit()
    expect(form.isDirty).toBe(false)
    expect(form.data.name).toBe('Jane Doe')
  })

  test('setData applies a batch atomically', async () => {
    const beforeValidateSpy = vi.fn()
    const form = useFormCore({
      schema: z.object({
        a: z.string(),
        b: z.string(),
      }),
      sourceValues: { a: 'a', b: 'b' },
      hooks: { beforeValidate: beforeValidateSpy },
      async submit() {},
    })

    form.setData((draft) => {
      draft.a = 'x'
      draft.b = 'y'
    })
    flush(form)

    expect(form.data).toEqual({ a: 'x', b: 'y' })
    expect(form.isDirty).toBe(true)

    await form.submit()
    // one batch -> one scheduled whole-form validation (plus the submit one)
    expect(beforeValidateSpy).toHaveBeenCalledTimes(2)
  })

  test('arktype delete extra keys', async () => {
    const form = useFormCore({
      schema: type({
        'name': 'string',
        'nested': {
          age: 'number',
        },
        '+': 'delete',
      }),
      sourceValues: {
        name: 'John',
        nested: {
          age: 42,
        },
        extra: 'This will be deleted',
      },
      async submit({ values }) {
        expect(values).toEqual({
          name: 'John',
          nested: {
            age: 42,
          },
        })
      },
    })

    await expect(form.submit()).resolves.toEqual({ success: true })
  })

  test('arktype mutates validation object', async () => {
    const form = useFormCore({
      schema: type({
        'address': {
          'city': 'string',
          '+': 'delete',
        },
        '+': 'delete',
      }),
      sourceValues: {
        address: {
          city: null,
        },
      },
      async submit() {},
    })

    form.fields.address.city.$use().handleChange('tiae')
    form.fields.address.city.$use().handleBlur()
    await sleep(10)
  })

  test('form disabled state', async () => {
    let disabled = true

    const form = useFormCore({
      schema: z.object({
        name: z.string(),
      }),
      sourceValues: {
        name: '',
      },
      disabled: () => disabled,
      async submit() {},
    })

    const field = form.fields.name.$use()
    expect(form.isLoading).toBe(false)
    expect(form.isDisabled).toBe(true)
    expect(field.disabled).toBe(true)

    disabled = false
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
    const nestedField = form.fields.array.at(0).name.$use()
    const ageField = form.fields.age.$use()

    expect(nestedField.errors).toBeUndefined()
    expect(ageField.errors).toBeUndefined()

    await form.submit()
    expect(nestedField.errors).toEqual(['Invalid input: expected string, received null'])
    expect(ageField.errors).toEqual(['Invalid input: expected number, received null'])

    // error resets after fixing the value
    ageField.handleChange(42)
    await vi.waitFor(() => expect(ageField.errors).toBeUndefined())
    expect(nestedField.errors).toEqual(['Invalid input: expected string, received null'])
    expect(form.errors?.length).toBeDefined()

    form.data.array![0]!.name = 'John'
    await vi.waitFor(() => expect(nestedField.errors).toBeUndefined())
    expect(ageField.errors).toBeUndefined()
    expect(form.errors).toBeUndefined()
  })

  test('error resets if no global form errors', async () => {
    const form = useFormCore({
      schema: z.object({
        name: z.number().nullable(),
      }),
      sourceValues: {
        name: null,
      },
      async submit() {},
    })

    const field = form.fields.name.$use()

    field.handleChange('' as never)
    field.handleBlur()
    await vi.waitFor(() => expect(field.errors).toBeDefined())

    field.handleChange(0)
    field.handleBlur()
    await vi.waitFor(() => expect(field.errors).toBeUndefined())
  })

  test('translate', () => {
    const form = useFormCore({
      schema: z.object({
        date: z.iso.date(),
      }),
      sourceValues: {
        date: '2025-01-01',
      },
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

  test('discriminator', () => {
    const loadedData = {
      union: {
        type: 'A' as const,
        value: 'Hello',
      },
    }
    let data: typeof loadedData | undefined

    const form = useFormCore({
      schema: z.object({
        union: z.discriminatedUnion('type', [
          z.object({
            type: z.literal('A'),
            value: z.string(),
          }),
          z.object({
            type: z.literal('B'),
            value: z.number(),
          }),
        ]),
      }),
      sourceValues: () => data,
      async submit() {},
    })

    const unionField = form.fields.union.$use({ discriminator: 'type' })

    expect(unionField.type).toBeNull()
    expect(unionField.$field.$use().value).toEqual(null)
    if (unionField.type === null) {
      expectTypeOf(unionField.$field.$use().value).toEqualTypeOf<
        | {
            type: 'A' | null
            value: string | null
          }
        | {
            type: 'B' | null
            value: number | null
          }
        | null
      >()
    }
    data = loadedData
    form['~'].refresh()
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
    let isLoading = true

    const form = useFormCore({
      schema: z.object({
        person: z.object({
          name: z.string(),
        }),
      }),
      sourceValues() {
        if (isLoading) return undefined

        return {
          person: { name: 'John Doe' },
        }
      },
      async submit() {
        await sleep(50)
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

    isLoading = false
    form['~'].refresh()
    flush(form)
    expect(nameField.isPending).toBe(false)
    expect(form.isLoading).toBe(false)

    expect(nameField.value).toBe('John Doe')
    expect(form.data?.person?.name).toBe('John Doe')

    const submitPromise = form.submit()

    await vi.waitFor(() => expect(form.isLoading).toBe(true))
    expect(nameField.isPending).toBe(false) // pending is only for loading source values

    await submitPromise

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

      // string
      const stringField = form.fields['foo.bar'].$use()
      expect(stringField.value).toBeNull()

      stringField.handleChange('Test')
      flush(form)

      expect(stringField.value).toBe('Test')
      expect(form.data['foo.bar']).toBe('Test')
      expect(stringField.path).toBe(String.raw`foo\.bar`)

      // array
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
        schema: z.object({
          array: z.array(z.string()),
        }),
        sourceValues: () => ({
          array: ['one', 'two'],
        }),
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
        schema: z.object({
          name: z.string(),
        }),
        sourceValues: () => ({
          name: 'John',
        }),
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
        obj: z.object({
          b: z.number(),
        }),
      }),
      sourceValues: {
        a: 'initial',
        array: ['one', 'two'],
        obj: {
          b: 123,
        },
      },
      async submit() {},
    })

    // root value itself is not writable
    expect(() => {
      // @ts-expect-error Prevent assignment to readonly property
      form.fields.$use().value = {}
    }).toThrow()

    // nested object props are writable and flow into the form data
    form.fields.$use().value.a = 'new value'
    flush(form)
    expect(form.data.a).toBe('new value')
    form.fields.$use().value.obj!.b = 456
    flush(form)
    expect(form.data.obj?.b).toBe(456)

    // pushing to array is allowed
    form.fields.array.$use().value?.push('three')
    flush(form)
    expect(form.data.array).toEqual(['one', 'two', 'three'])
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

  test('beforeFieldChange, afterFieldChange', async () => {
    const beforeFieldChangeSpy = vi.fn()
    const afterFieldChangeSpy = vi.fn()

    const form = useFormCore({
      schema: z.object({
        name: z.string(),
      }),
      sourceValues: {
        name: 'John',
      },
      hooks: {
        beforeFieldChange: beforeFieldChangeSpy,
        afterFieldChange: afterFieldChangeSpy,
      },
      async submit() {},
    })

    const field = form.fields.name.$use()
    field.handleChange('Jane')

    await sleep(10)

    expect(beforeFieldChangeSpy).toHaveBeenCalledWith(field, 'Jane')
    expect(afterFieldChangeSpy).toHaveBeenCalledWith(field, 'Jane')
    expect(beforeFieldChangeSpy).toHaveBeenCalledBefore(afterFieldChangeSpy)
  })

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

describe('arrays', () => {
  function setupItemsForm() {
    return useFormCore({
      schema: z.object({
        items: z.array(
          z.object({
            a: z.string(),
            b: z.number(),
          }),
        ),
      }),
      sourceValues: {
        items: [
          { a: '1', b: 1 },
          { a: '2', b: 2 },
          { a: '3', b: 3 },
        ],
      },
      async submit() {},
    })
  }

  test('fields keep identity across reorder', () => {
    const form = setupItemsForm()

    const keyItem0 = form.fields.items.at(0).$use().key
    const keyItem2 = form.fields.items.at(2).$use().key
    expect(keyItem0).not.toBe(keyItem2)

    // mark the first item's leaf dirty (in-place write keeps the datum)
    const a0 = form.fields.items.at(0).a.$use()
    a0.handleChange('edited')
    flush(form)
    expect(a0.isDirty).toBe(true)

    form.data.items!.reverse()
    flush(form)

    // the same fields now live at swapped indices: identity follows the datum
    expect(form.fields.items.at(2).$use().key).toBe(keyItem0)
    expect(form.fields.items.at(0).$use().key).toBe(keyItem2)
    expect(form.fields.items.at(2).a.$use().key).toBe(a0.key)
    expect(form.fields.items.at(2).a.$use().isDirty).toBe(true)
    expect(form.fields.items.at(2).a.$use().value).toBe('edited')
  })

  test('identity preserved across splice insert/remove', () => {
    const form = setupItemsForm()

    const item1 = form.fields.items.at(1).$use()
    const key1 = item1.key

    form.data.items!.splice(1, 0, { a: 'inserted', b: 9 })
    flush(form)

    // the inserted element gets a fresh field, existing elements keep theirs
    expect(form.fields.items.at(2).$use().key).toBe(key1)
    expect(form.fields.items.at(1).$use().key).not.toBe(key1)

    form.data.items!.splice(1, 1)
    flush(form)

    expect(form.fields.items.at(1).$use().key).toBe(key1)
  })

  test('identity preserved across sort and unshift', () => {
    const form = setupItemsForm()

    const byA = (
      x: { a: string | null } | null,
      y: { a: string | null; b: number | null } | null,
    ) => (x?.a ?? '').localeCompare(y?.a ?? '')
    const item3 = form.fields.items.at(2).$use()
    const key3 = item3.key

    form.data.items!.sort(byA)
    flush(form)
    expect(form.fields.items.at(2).$use().key).toBe(key3)

    form.data.items!.unshift({ a: '0', b: 0 })
    flush(form)
    expect(form.fields.items.at(3).$use().key).toBe(key3)
  })

  test('primitive arrays are positional (documented limitation)', () => {
    const form = useFormCore({
      schema: z.object({
        tags: z.array(z.string()),
      }),
      sourceValues: { tags: ['one', 'two'] },
      async submit() {},
    })

    const tag0 = form.fields.tags.at(0).$use()
    const key0 = tag0.key

    form.data.tags!.reverse()
    flush(form)

    // state stays with the index, not the value
    expect(form.fields.tags.at(0).$use().key).toBe(key0)
    expect(form.fields.tags.at(0).$use().value).toBe('two')
  })

  test('delete removes the right element by identity after reorder', () => {
    const form = setupItemsForm()

    const item0 = form.fields.items.at(0).$use()
    form.data.items!.reverse()
    flush(form)

    // item0's datum ('1') now sits at index 2; delete via its key
    form.fields.items.delete(item0.key)
    flush(form)

    expect(form.data.items).toEqual([
      { a: '3', b: 3 },
      { a: '2', b: 2 },
    ])
  })

  test('delete throws for non-array-item keys', () => {
    const form = setupItemsForm()

    expect(() => form.fields.items.delete(form.fields.items.at(0).a.$use().key)).toThrow(
      'Key does not reference an array item',
    )
    expect(() => form.fields.items.delete('made-up-key')).toThrow(
      'Key does not reference an array item',
    )
  })

  test('iteration reflects current elements', () => {
    const form = setupItemsForm()

    const keysBefore = [...form.fields.items].map((item) => item.$use().key)
    expect(keysBefore).toHaveLength(3)

    form.data.items!.reverse()
    flush(form)

    const keysAfter = [...form.fields.items].map((item) => item.$use().key)
    expect(keysAfter).toEqual([...keysBefore].reverse())
  })

  test('reset keeps fields stable positionally', () => {
    const form = setupItemsForm()

    const item0 = form.fields.items.at(0).$use()
    const key0 = item0.key
    // in-place leaf edit keeps the datum (a wholesale replace creates a new element)
    const a0 = form.fields.items.at(0).a.$use()
    a0.handleChange('edited')
    flush(form)
    expect(a0.isDirty).toBe(true)

    form.reset()
    flush(form)

    expect(form.data.items).toEqual([
      { a: '1', b: 1 },
      { a: '2', b: 2 },
      { a: '3', b: 3 },
    ])
    expect(form.fields.items.at(0).$use().key).toBe(key0)
    expect(form.fields.items.at(0).a.$use().key).toBe(a0.key)
    expect(form.fields.items.at(0).a.$use().isDirty).toBe(false)
    expect(form.isDirty).toBe(false)
  })

  test('field reset on an object element keeps the field identity', () => {
    const form = setupItemsForm()

    const item1 = form.fields.items.at(1).$use()
    const key1 = item1.key
    // in-place leaf edit keeps the element's node alive
    form.fields.items.at(1).a.$use().handleChange('edited')
    flush(form)
    expect(form.data.items![1]).toEqual({ a: 'edited', b: 2 })

    item1.reset()
    flush(form)

    // the field survives its own reset and stays bound to the element
    expect(item1.key).toBe(key1)
    expect(form.fields.items.at(1).$use().key).toBe(key1)
    expect(form.fields.items.at(1).$use().value).toEqual({ a: '2', b: 2 })
  })

  test('File values stay opaque leaves', async () => {
    const file = new File(['hello'], 'hello.txt')
    const form = useFormCore({
      schema: z.object({
        attachment: z.custom<File>(),
      }),
      sourceValues: {
        attachment: file,
      },
      async submit({ values }) {
        expect(values.attachment).toBe(file)
      },
    })

    expect(form.data.attachment).toBe(file)
    await expect(form.submit()).resolves.toEqual({ success: true })
  })

  test('reconcileKey preserves identity across external refresh', () => {
    let sourceValues = {
      items: [
        { id: 'x', a: '1', b: 1 },
        { id: 'y', a: '2', b: 2 },
      ],
    }
    const form = useFormCore({
      schema: z.object({
        items: z.array(
          z.object({
            id: z.string(),
            a: z.string(),
            b: z.number(),
          }),
        ),
      }),
      sourceValues: () => sourceValues,
      reconcileKey: 'id',
      async submit() {},
    })

    const itemY = form.fields.items.at(1).$use()
    const keyY = itemY.key

    // server-side reorder of the same entities
    sourceValues = {
      items: [
        { id: 'y', a: '2', b: 2 },
        { id: 'x', a: '1', b: 1 },
      ],
    }
    form['~'].refresh()
    flush(form)

    expect(form.fields.items.at(0).$use().key).toBe(keyY)
  })
})
