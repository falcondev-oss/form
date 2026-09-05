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

  test('writes apply on flush', async () => {
    const form = useFormCore({
      schema: z.object({
        name: z.string(),
      }),
      sourceValues: {
        name: 'John Doe',
      },
      async submit() {},
    })

    const spy = vi.fn()
    form['~'].subscribe(spy)

    form.fields.name.$use().handleChange('Isaac Newton')
    expect(form.data.name).toBe('John Doe')
    expect(spy).not.toHaveBeenCalled()

    await Promise.resolve()
    expect(form.data.name).toBe('Isaac Newton')
    expect(spy).toHaveBeenCalledWith(form)
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
      form['~'].flush()
      expect(form.data.name).toBe('Jane Smith')
    })

    test('key resolver keeps fields across a reordered refresh', () => {
      const [sourceValues, setSourceValues] = createSignal({
        items: [
          { id: 1, name: 'a' },
          { id: 2, name: 'b' },
        ],
      })
      const form = useFormCore({
        sourceValues,
        key: 'id',
        schema: z.object({
          items: z.array(z.object({ id: z.number(), name: z.string() })),
        }),
        async submit() {},
      })

      const second = form.fields.items.at(1).$use()

      setSourceValues({
        items: [
          { id: 2, name: 'b2' },
          { id: 1, name: 'a2' },
        ],
      })
      form['~'].flush()

      expect(form.fields.items.at(0).$use()).toBe(second)
      expect(second.value).toEqual({ id: 2, name: 'b2' })
    })

    test('reset keeps fields stable', () => {
      const [sourceValues, setSourceValues] = createSignal({
        items: [{ name: 'a' }, { name: 'b' }],
      })
      const form = useFormCore({
        sourceValues,
        schema: z.object({
          items: z.array(z.object({ name: z.string() })),
        }),
        async submit() {},
      })

      const first = form.fields.items.at(0).$use()
      const firstName = form.fields.items.at(0).name.$use()

      setSourceValues({ items: [{ name: 'x' }, { name: 'y' }] })
      form['~'].flush()

      expect(form.fields.items.at(0).$use()).toBe(first)
      expect(form.fields.items.at(0).name.$use()).toBe(firstName)
      expect(firstName.value).toBe('x')
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

  test('reset', async () => {
    const form = useFormCore({
      schema: z.object({
        name: z.string().min(1),
      }),
      sourceValues: {
        name: 'John',
      },
      async submit() {},
    })
    const nameField = form.fields.name.$use()

    nameField.handleChange('')
    await sleep(0)
    expect(nameField.errors).toBeDefined()
    expect(form.isDirty).toBe(true)

    form.reset()
    form['~'].flush()
    expect(form.data.name).toBe('John')
    expect(form.isDirty).toBe(false)
    expect(nameField.isDirty).toBe(false)
    expect(nameField.errors).toBeUndefined()
  })

  test('setData', async () => {
    const beforeValidate = vi.fn()
    const form = useFormCore({
      schema: z.object({
        name: z.string(),
        tags: z.array(z.string()),
      }),
      sourceValues: {
        name: 'John',
        tags: ['a'],
      },
      hooks: { beforeValidate },
      async submit() {},
    })
    const nameField = form.fields.name.$use()

    form.setData((data) => {
      data.name = null
      data.tags!.push('b')
    })
    form['~'].flush()

    expect(form.data).toEqual({ name: null, tags: ['a', 'b'] })
    expect(form.isDirty).toBe(true)
    await sleep(0)
    expect(nameField.errors).toEqual(['Invalid input: expected string, received null'])
    expect(beforeValidate).toHaveBeenCalledOnce()

    form.setData((data) => {
      data.name = 'Jane'
    })
    await sleep(0)
    expect(nameField.errors).toBeUndefined()
  })

  test('arktype delete extra keys', async () => {
    const sourceValues = {
      name: 'John',
      nested: {
        age: 42,
      },
      extra: 'This will be deleted',
    }
    const form = useFormCore({
      schema: type({
        'name': 'string',
        'nested': {
          age: 'number',
        },
        '+': 'delete',
      }),
      sourceValues,
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
    expect(sourceValues.extra).toBe('This will be deleted')
    expect(form.data).toEqual(sourceValues)
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
    form['~'].flush()
    expect(nestedField.errors).toEqual(['Invalid input: expected string, received null'])
    expect(ageField.errors).toEqual(['Invalid input: expected number, received null'])

    // error resets
    ageField.handleChange(42)
    await sleep(0)
    expect(nestedField.errors).toEqual(['Invalid input: expected string, received null'])
    expect(ageField.errors).toBeUndefined()
    expect(form.errors?.length).toBeDefined()

    form.data.array![0]!.name = 'John'
    await sleep(0)
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
    field.handleBlur()
    await sleep(0)
    expect(field.errors).toBeDefined()

    field.handleChange(0)
    field.handleBlur()
    await sleep(0)
    expect(field.errors).toBeUndefined()
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
    form['~'].flush()
    expect(nameField.value).toBeNull()

    setIsLoading(false)
    form['~'].flush()
    expect(nameField.isPending).toBe(false)
    expect(form.isLoading).toBe(false)

    expect(nameField.value).toBe('John Doe')
    expect(form.data?.person?.name).toBe('John Doe')

    const submit = form.submit()

    await sleep(10)
    form['~'].flush()
    expect(form.isLoading).toBe(true)
    expect(nameField.isPending).toBe(false) // pending is only for loading source values

    await submit
    form['~'].flush()

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

      // primitive array elements are positional
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

    expect(() => {
      // @ts-expect-error Prevent assignment to readonly property
      form.fields.$use().value = {}
    }).toThrow(TypeError)

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
    form['~'].flush()

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

    await sleep(100)

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
  function setup() {
    return useFormCore({
      schema: z.object({
        items: z.array(
          z.object({
            a: z.string().min(1),
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

  test('replacing the array creates new element fields', async () => {
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

    // the new element is a new datum, so it gets a fresh field
    expect(form.fields.items.at(2)?.a.$use().key).not.toBe(a2PrevKey)
    expect(form.fields.items.$use()).toBe(items)

    expect(form.data.items).toEqual([
      { a: '1', b: 1 },
      { a: '2', b: 2 },
      { a: '3', b: 3 },
    ])
  })

  test('delete by key', () => {
    const form = setup()

    expect(() => form.fields.items.delete(form.fields.items.at(2).a.$use().key)).toThrow(
      'Key does not reference an array item',
    )

    const second = form.fields.items.at(1).$use()
    form.data.items!.reverse()
    form['~'].flush()

    form.fields.items.delete(second.key)
    form['~'].flush()
    expect(form.data.items).toEqual([
      { a: '3', b: 3 },
      { a: '1', b: 1 },
    ])
  })

  test('fields follow their element across reorders', async () => {
    const form = setup()

    const first = form.fields.items.at(0).$use()
    const firstA = form.fields.items.at(0).a.$use()
    const third = form.fields.items.at(2).$use()

    firstA.handleChange('')
    await sleep(0)
    expect(firstA.isDirty).toBe(true)
    expect(firstA.errors).toEqual(['Too small: expected string to have >=1 characters'])

    form.data.items!.reverse()
    form['~'].flush()

    expect(form.fields.items.at(2).$use()).toBe(first)
    expect(form.fields.items.at(2).a.$use()).toBe(firstA)
    expect(form.fields.items.at(0).$use()).toBe(third)
    expect(firstA.path).toBe('items[2].a')
    expect(firstA.value).toBe('')
    expect(firstA.isDirty).toBe(true)
    expect(firstA.errors).toEqual(['Too small: expected string to have >=1 characters'])
    expect(first.value).toEqual({ a: '', b: 1 })

    form.data.items!.sort((x, y) => x!.b! - y!.b!)
    form['~'].flush()
    expect(form.fields.items.at(0).$use()).toBe(first)
    expect(firstA.path).toBe('items[0].a')

    form.data.items!.splice(1, 0, { a: 'new', b: 0 })
    form['~'].flush()
    expect(form.fields.items.at(0).$use()).toBe(first)
    expect(form.fields.items.at(3).$use()).toBe(third)
    expect(form.fields.items.at(1).$use()).not.toBe(first)

    form.data.items!.unshift({ a: 'first', b: -1 })
    form.data.items!.splice(2, 1)
    form['~'].flush()
    expect(form.data.items).toEqual([
      { a: 'first', b: -1 },
      { a: '', b: 1 },
      { a: '2', b: 2 },
      { a: '3', b: 3 },
    ])
    expect(form.fields.items.at(1).$use()).toBe(first)
    expect(form.fields.items.at(3).$use()).toBe(third)
    expect(third.path).toBe('items[3]')
    expect([...form.fields.items].map((item) => item.$use())).toEqual([
      form.fields.items.at(0).$use(),
      first,
      form.fields.items.at(2).$use(),
      third,
    ])
  })

  test('data writes after a reorder validate the moved element', async () => {
    const form = setup()
    const thirdA = form.fields.items.at(2).a.$use()
    // cache a facade of the element while it sits at index 2
    expect(form.data.items![2]!.a).toBe('3')

    form.data.items!.reverse()
    form['~'].flush()
    form.data.items![0]!.a = ''
    await sleep(0)

    expect(thirdA.value).toBe('')
    expect(thirdA.errors).toEqual(['Too small: expected string to have >=1 characters'])
  })

  test('removed element field detaches', () => {
    const form = setup()
    const second = form.fields.items.at(1).$use()

    form.data.items!.splice(1, 1)
    form['~'].flush()

    expect(second.value).toBeNull()
    expect(form.fields.items.at(1).$use()).not.toBe(second)
  })

  test('primitive elements stay positional', () => {
    const form = useFormCore({
      schema: z.object({
        tags: z.array(z.string()),
      }),
      sourceValues: {
        tags: ['a', 'b'],
      },
      async submit() {},
    })

    const first = form.fields.tags.at(0).$use()
    form.data.tags!.reverse()
    form['~'].flush()

    expect(form.fields.tags.at(0).$use()).toBe(first)
    expect(first.value).toBe('b')
  })

  test('object properties stay bound by name', () => {
    const form = useFormCore({
      schema: z.object({
        person: z.object({ name: z.string() }),
      }),
      sourceValues: {
        person: { name: 'John' },
      },
      async submit() {},
    })

    const name = form.fields.person.name.$use()
    form.data.person = { name: 'Jane' }
    form['~'].flush()

    expect(form.fields.person.name.$use()).toBe(name)
    expect(name.value).toBe('Jane')
  })
})
