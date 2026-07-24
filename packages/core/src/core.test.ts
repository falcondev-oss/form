import { createSignal } from '@solidjs/signals'
import { type } from 'arktype'
import { describe, expect, expectTypeOf, test, vi } from 'vitest'
import z from 'zod'
import { useFormCore } from './core'
import { sleep } from './util'

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
      form['~'].flush()

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
      form['~'].flush()

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

    const spy = vi.fn()

    form['~'].subscribe(spy)

    form.fields.name.$use().handleChange('Isaac Newton')
    form['~'].flush()
    expect(spy).toHaveBeenCalled()
  })

  test('field-only dirty state changes notify subscribers', () => {
    const form = useFormCore({
      schema: z.object({ name: z.string() }),
      sourceValues: { name: 'John Doe' },
      async submit() {},
    })
    const field = form.fields.name.$use()
    const spy = vi.fn()
    form['~'].subscribe(spy)

    field.handleChange('John Doe')
    expect(field.isDirty).toBe(true)
    expect(spy).toHaveBeenCalled()

    spy.mockClear()
    field.reset()
    expect(field.isDirty).toBe(false)
    expect(spy).toHaveBeenCalled()
  })

  test('setData batches writes into one validation', async () => {
    const beforeValidate = vi.fn()
    const form = useFormCore({
      schema: z.object({ first: z.string(), last: z.string() }),
      sourceValues: { first: 'John', last: 'Doe' },
      hooks: { beforeValidate },
      async submit() {},
    })

    form.setData((data) => {
      data.first = 'Jane'
      data.last = 'Smith'
    })
    expect(form.data).toEqual({ first: 'John', last: 'Doe' })

    form['~'].flush()
    expect(form.data).toEqual({ first: 'Jane', last: 'Smith' })
    await vi.waitFor(() => expect(beforeValidate).toHaveBeenCalledOnce())
  })

  test('a no-op reset does not suppress the next edit', async () => {
    const beforeValidate = vi.fn()
    const form = useFormCore({
      schema: z.object({ name: z.string() }),
      sourceValues: { name: 'John' },
      hooks: { beforeValidate },
      async submit() {},
    })

    form.reset()
    form.data.name = 'Jane'
    form['~'].flush()

    expect(form.isDirty).toBe(true)
    await vi.waitFor(() => expect(beforeValidate).toHaveBeenCalledOnce())
  })

  describe('sourceValues', () => {
    test('forbid updates when dirty', () => {
      const [sourceValues, setSourceValues] = createSignal({
        name: 'John Doe',
      })
      const form = useFormCore({
        sourceValues,
        schema: z.object({
          name: z.string(),
        }),
        async submit() {},
      })

      form.data.name = 'Jane Doe'
      form['~'].flush()
      expect(form.data.name).toBe('Jane Doe')

      setSourceValues({
        name: 'Alice Johnson',
      })
      form['~'].flush()
      expect(form.data.name).toBe('Jane Doe')
    })

    test('allow updates during submit', async () => {
      const [sourceValues, setSourceValues] = createSignal({
        name: 'John Doe',
      })
      const form = useFormCore({
        sourceValues,
        schema: z.object({
          name: z.string(),
        }),
        async submit() {
          setSourceValues({
            name: 'Jane Smith',
          })
        },
      })

      // make form dirty
      form.data.name = 'Jane Doe'
      form['~'].flush()
      expect(form.data.name).toBe('Jane Doe')

      await form.submit()
      expect(form.data.name).toBe('Jane Smith')
    })

    test('key resolver preserves row identity across a source refresh', () => {
      const [sourceValues, setSourceValues] = createSignal({
        items: [
          { id: 1, name: 'first' },
          { id: 2, name: 'second' },
        ],
      })
      const form = useFormCore({
        sourceValues,
        schema: z.object({
          items: z.array(z.object({ id: z.number(), name: z.string() })),
        }),
        reconcileKey: (item) => (item as { id: number }).id,
        async submit() {},
      })
      const firstKey = form.fields.items.at(0).$use().key

      setSourceValues({
        items: [
          { id: 2, name: 'second updated' },
          { id: 1, name: 'first updated' },
        ],
      })
      form['~'].flush()

      expect(form.fields.items.at(1).$use().key).toBe(firstKey)
      expect(form.data.items![1]!.name).toBe('first updated')
    })

    test('explicit reset remains positional when a key resolver is configured', () => {
      const form = useFormCore({
        sourceValues: {
          items: [
            { id: 1, name: 'first' },
            { id: 2, name: 'second' },
          ],
        },
        schema: z.object({
          items: z.array(z.object({ id: z.number(), name: z.string() })),
        }),
        reconcileKey: (item) => (item as { id: number }).id,
        async submit() {},
      })
      const secondKey = form.fields.items.at(1).$use().key

      form.data.items!.reverse()
      form['~'].flush()
      expect(form.fields.items.at(0).$use().key).toBe(secondKey)

      form.reset()
      form['~'].flush()

      expect(form.data.items!.map((item) => item!.id)).toEqual([1, 2])
      expect(form.fields.items.at(0).$use().key).toBe(secondKey)
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
    form['~'].flush()
    expect(form.isDirty).toBe(true)

    await form.submit()
    expect(form.isDirty).toBe(false)
    expect(form.data.name).toBe('Jane Doe')
  })

  test('reset restores source values without remounting array positions', () => {
    const form = useFormCore({
      sourceValues: { items: [{ name: 'a' }, { name: 'b' }] },
      schema: z.object({ items: z.array(z.object({ name: z.string() })) }),
      async submit() {},
    })

    form.data.items!.reverse()
    form['~'].flush()
    const keys = [...form.fields.items].map((item) => item.$use().key)

    form.reset()
    form['~'].flush()

    expect(form.data.items!.map((item) => item!.name)).toEqual(['a', 'b'])
    expect([...form.fields.items].map((item) => item.$use().key)).toEqual(keys)
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
  })

  test('form disabled state', async () => {
    const [disabled, setDisabled] = createSignal(true)

    const form = useFormCore({
      schema: z.object({
        name: z.string(),
      }),
      sourceValues: {
        name: '',
      },
      disabled,
      async submit() {},
    })

    const field = form.fields.name.$use()
    expect(form.isLoading).toBe(false)
    expect(form.isDisabled).toBe(true)
    expect(field.disabled).toBe(true)

    setDisabled(false)
    form['~'].flush()
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

    // error resets
    ageField.handleChange(42)
    form['~'].flush()
    await vi.waitFor(() => expect(ageField.errors).toBeUndefined())
    expect(nestedField.errors).toEqual(['Invalid input: expected string, received null'])
    expect(ageField.errors).toBeUndefined()
    expect(form.errors?.length).toBeDefined()

    form.data.array![0]!.name = 'John'
    form['~'].flush()
    await vi.waitFor(() => expect(form.errors).toBeUndefined())
    expect(nestedField.errors).toBeUndefined()
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
    form['~'].flush()
    field.handleBlur()
    await vi.waitFor(() => expect(field.errors).toBeDefined())

    field.handleChange(0)
    form['~'].flush()
    field.handleBlur()
    await vi.waitFor(() => expect(field.errors).toBeUndefined())
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
    form['~'].flush()

    expect(fieldT.value).toEqual(now)
    expect(field.value).toBe(now.toISOString())
    expect(form.data.date).toBe(now.toISOString())

    now = new Date(+now + 1)
    field.handleChange(now.toISOString())
    form['~'].flush()

    expect(fieldT.value).toEqual(now)
    expect(field.value).toBe(now.toISOString())
    expect(form.data.date).toBe(now.toISOString())
  })

  test('discriminator', async () => {
    const loadedData = {
      union: {
        type: 'A' as const,
        value: 'Hello',
      },
    }
    const [data, setData] = createSignal<typeof loadedData>()

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
      sourceValues: data,
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
    setData(loadedData)
    form['~'].flush()

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
    form['~'].flush()
    expect(unionField.$field.$use().value).toEqual({ type: 'B', value: 42 })
    if (unionField.type === 'B') {
      expectTypeOf(unionField.$field.$use().value).toEqualTypeOf<{
        type: 'B' | null
        value: number | null
      } | null>()
    }
  })

  test('sourceValues is undefined', async () => {
    const [isLoading, setIsLoading] = createSignal(true)

    const form = useFormCore({
      schema: z.object({
        person: z.object({
          name: z.string(),
        }),
      }),
      sourceValues() {
        if (isLoading()) return

        return {
          person: { name: 'John Doe' },
        }
      },
      async submit() {
        await sleep(1000)
        return { success: true }
      },
    })

    const nameField = form.fields.person.name.$use()
    expect(nameField.isPending).toBe(true)
    expect(form.isLoading).toBe(true)
    expect(form.data?.person).toBeUndefined()
    expect(nameField.value).toBeNull()

    nameField.handleChange('Input is ignored')
    expect(nameField.value).toBeNull()

    setIsLoading(false)
    form['~'].flush()
    expect(nameField.isPending).toBe(false)
    expect(form.isLoading).toBe(false)

    expect(nameField.value).toBe('John Doe')
    expect(form.data?.person?.name).toBe('John Doe')

    const submit = form.submit()

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

      // string
      const stringField = form.fields['foo.bar'].$use()
      expect(stringField.value).toBeNull()

      stringField.handleChange('Test')
      form['~'].flush()

      expect(stringField.value).toBe('Test')
      expect(form.data['foo.bar']).toBe('Test')
      expect(stringField.path).toBe(String.raw`foo\.bar`)

      // array (has special cache handling)
      const arrayField = form.fields['foo.bar.array'].at(0).$use()
      expect(arrayField.value).toBe('one')
      expect(form.data['foo.bar.array']?.[0]).toEqual('one')

      form.data['foo.bar.array']?.unshift('zero')
      form['~'].flush()

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
      form['~'].flush()

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

    // @ts-expect-error Prevent assignment to readonly property
    expect(() => (form.fields.$use().value = {})).toThrow(TypeError)

    form.fields.$use().value.a = 'new value'
    form['~'].flush()
    expect(form.data.a).toBe('new value')
    form.fields.$use().value.obj!.b = 456
    form['~'].flush()
    expect(form.data.obj?.b).toBe(456)

    // pushing to array is allowed
    form.fields.array.$use().value?.push('three')
    form['~'].flush()
    expect(form.data.array).toEqual(['one', 'two', 'three'])
  })

  test('opaque values and serialized data stay untouched', () => {
    class Upload {
      constructor(readonly name: string) {}
    }
    const upload = new Upload('avatar.png')
    const form = useFormCore({
      schema: z.object({ upload: z.custom<Upload>() }),
      sourceValues: { upload },
      async submit() {},
    })

    expect(form.fields.upload.$use().value).toBe(upload)
    expect(JSON.stringify(form.data)).toBe('{"upload":{"name":"avatar.png"}}')
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

    result = await form.submit()

    expect(result.success).toBe(false)
    expect(beforeSubmitSpy).toHaveBeenNthCalledWith(2, { data: { name: 2 } })
    expect(afterSubmitSpy).toHaveBeenNthCalledWith(2, { success: false })
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

    await sleep(100)

    expect(beforeFieldChangeSpy).toHaveBeenCalledWith(field, 'Jane')
    expect(afterFieldChangeSpy).toHaveBeenCalledWith(field, 'Jane')
    expect(beforeFieldChangeSpy).toHaveBeenCalledBefore(afterFieldChangeSpy)
  })

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

  test('arrays', async () => {
    const form = useFormCore({
      schema: z.object({
        items: z.array(
          z.object({
            a: z.string(),
            b: z.number(),
          }),
        ),
      }),
      sourceValues: {
        items: [],
      },
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
    form['~'].flush()
    expect(a2.value).toBe('3')

    // after handleChange, fieldCache is cleared
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
    form['~'].flush()
    expect(form.data.items).toEqual([
      { a: '1', b: 1 },
      { a: '2', b: 2 },
    ])
  })

  test('object array fields keep their identity when reordered', () => {
    const form = useFormCore({
      schema: z.object({
        items: z.array(z.object({ name: z.string() })),
      }),
      sourceValues: {
        items: [{ name: 'first' }, { name: 'second' }],
      },
      async submit() {},
    })

    const first = form.fields.items.at(0).name.$use()
    first.handleChange('edited')
    form['~'].flush()
    expect(form.fields.items.at(0).name.$use().key).toBe(first.key)

    form.data.items!.reverse()
    form['~'].flush()

    const moved = form.fields.items.at(1).name.$use()
    expect(moved.key).toBe(first.key)
    expect(moved.value).toBe('edited')
    expect(moved.isDirty).toBe(true)
  })

  test('object array identity survives every mutation shape', () => {
    const form = useFormCore({
      schema: z.object({
        items: z.array(z.object({ name: z.string() })),
      }),
      sourceValues: {
        items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      },
      async submit() {},
    })
    const keys = Object.fromEntries(
      [...form.fields.items].map((item) => {
        const field = item.$use()
        return [field.value!.name, field.key]
      }),
    ) as Record<string, string>

    form.data.items!.reverse()
    form['~'].flush()
    expect(form.fields.items.at(2).$use().key).toBe(keys.a)

    form.data.items!.sort((a, b) => a!.name!.localeCompare(b!.name!))
    form['~'].flush()
    expect([...form.fields.items].map((item) => item.$use().key)).toEqual([keys.a, keys.b, keys.c])

    form.data.items!.push({ name: 'pushed' })
    form['~'].flush()
    expect([...form.fields.items].slice(0, 3).map((item) => item.$use().key)).toEqual([
      keys.a,
      keys.b,
      keys.c,
    ])
    form.data.items!.pop()

    form.data.items!.unshift({ name: 'new' })
    form['~'].flush()
    const shifted = form.data.items!.shift()
    expect(shifted?.name).toBe('new')
    form.data.items!.splice(2, 0, { name: 'inserted' })
    form.data.items!.splice(2, 1)
    form['~'].flush()
    expect(form.fields.items.at(0).$use().key).toBe(keys.a)

    const [moved] = form.data.items!.splice(0, 1)
    form.data.items!.splice(2, 0, moved!)
    form['~'].flush()
    expect(form.fields.items.at(2).$use().key).toBe(keys.a)

    form.fields.items.delete(keys.a!)
    form['~'].flush()
    expect(form.data.items!.map((item) => item!.name)).not.toContain('a')

    form.data.items!.fill({ name: 'filled' }, 1, 2)
    form['~'].flush()
    expect(form.fields.items.at(0).$use().key).toBe(keys.b)
  })

  test('direct index assignment moves existing object identity', () => {
    const form = useFormCore({
      schema: z.object({
        items: z.array(z.object({ name: z.string() })),
      }),
      sourceValues: {
        items: [{ name: 'a' }, { name: 'b' }],
      },
      async submit() {},
    })
    const first = form.fields.items.at(0).$use()
    const second = form.fields.items.at(1).$use()
    const moved = form.data.items![0]!

    form.data.items![0] = form.data.items![1]!
    form.data.items![1] = moved
    form['~'].flush()

    expect(form.fields.items.at(0).$use().key).toBe(second.key)
    expect(form.fields.items.at(1).$use().key).toBe(first.key)
  })

  test('array object validation errors move with field identity', async () => {
    const form = useFormCore({
      schema: z.object({
        items: z.array(z.object({ name: z.string().min(1) })),
      }),
      sourceValues: {
        items: [{ name: '' }, { name: 'valid' }],
      },
      async submit() {},
    })
    const invalid = form.fields.items.at(0).name.$use()

    await form.submit()
    expect(invalid.errors).toBeDefined()
    form.data.items!.reverse()
    form['~'].flush()

    expect(form.fields.items.at(1).name.$use().key).toBe(invalid.key)
    await vi.waitFor(() => expect(form.fields.items.at(1).name.$use().errors).toBeDefined())
  })

  test('primitive array fields remain positional when reordered', () => {
    const form = useFormCore({
      schema: z.object({ tags: z.array(z.string()) }),
      sourceValues: { tags: ['a', 'b'] },
      async submit() {},
    })
    const first = form.fields.tags.at(0).$use()

    form.data.tags!.reverse()
    form['~'].flush()

    expect(form.fields.tags.at(0).$use().key).toBe(first.key)
    expect(first.value).toBe('b')
  })
})
