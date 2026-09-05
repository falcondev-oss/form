import { createSignal, createEffect } from '@solidjs/signals'

function ref<T>(value: T): { value: T }
function ref<T>(): { value: T | undefined }
function ref<T>(value?: T) {
  const [get, set] = createSignal<T | undefined>(value as Exclude<T, Function> | undefined)
  return {
    get value() {
      return get()
    },
    set value(value) {
      set(() => value)
    },
  }
}
function watch<T>(get: () => T, effect: (value: T) => void) {
  createEffect(get, effect, { defer: true })
}
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

      form['~'].flush()
      expect(form.data.name).toBe('')
      form['~'].flush()
      expect(form.isChanged).toBe(false)

      form.fields.name.$use().handleChange('Jane Doe')

      form['~'].flush()
      expect(form.data.name).toBe('Jane Doe')
      form['~'].flush()
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

      form['~'].flush()
      expect(form.data.name).toBe('John Doe')
      form['~'].flush()
      expect(form.isChanged).toBe(false)

      form.fields.name.$use().handleChange('Jane Doe')

      form['~'].flush()
      expect(form.data.name).toBe('Jane Doe')
      form['~'].flush()
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

    form['~'].flush()
    expect(form.data.name).toBe('John Doe')

    const spy = vi.fn()

    watch(
      () => form.data.name,
      (value) => void spy(value),
    )

    form.fields.name.$use().handleChange('Isaac Newton')
    form['~'].flush()
    expect(spy).toHaveBeenCalledWith('Isaac Newton')
  })

  describe('sourceValues', () => {
    test('forbid updates when dirty', () => {
      const sourceValues = ref({
        name: 'John Doe',
      })
      const form = useFormCore({
        sourceValues: () => sourceValues.value,
        schema: z.object({
          name: z.string(),
        }),
        async submit() {},
      })

      form.data.name = 'Jane Doe'
      form['~'].flush()
      expect(form.data.name).toBe('Jane Doe')

      sourceValues.value = {
        name: 'Alice Johnson',
      }
      form['~'].flush()
      expect(form.data.name).toBe('Jane Doe')
    })

    test('allow updates during submit', async () => {
      const sourceValues = ref({
        name: 'John Doe',
      })
      const form = useFormCore({
        sourceValues: () => sourceValues.value,
        schema: z.object({
          name: z.string(),
        }),
        async submit() {
          sourceValues.value = {
            name: 'Jane Smith',
          }
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
    form['~'].flush()
    expect(form.isDirty).toBe(false)
    form['~'].flush()
    expect(form.data.name).toBe('Jane Doe')
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
        form['~'].flush()
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
    form['~'].flush()
    form.fields.address.city.$use().handleBlur()
  })

  test('form disabled state', async () => {
    const disabled = ref(true)

    const form = useFormCore({
      schema: z.object({
        name: z.string(),
      }),
      sourceValues: {
        name: '',
      },
      disabled: () => disabled.value ?? false,
      async submit() {},
    })

    const field = form.fields.name.$use()
    form['~'].flush()
    expect(form.isLoading).toBe(false)
    form['~'].flush()
    expect(form.isDisabled).toBe(true)
    form['~'].flush()
    expect(field.disabled).toBe(true)

    disabled.value = false
    form['~'].flush()
    expect(form.isLoading).toBe(false)
    form['~'].flush()
    expect(form.isDisabled).toBe(false)
    form['~'].flush()
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

    form['~'].flush()
    expect(nestedField.errors).toBeUndefined()
    form['~'].flush()
    expect(ageField.errors).toBeUndefined()

    await form.submit()
    form['~'].flush()
    expect(nestedField.errors).toEqual(['Invalid input: expected string, received null'])
    form['~'].flush()
    expect(ageField.errors).toEqual(['Invalid input: expected number, received null'])

    // error resets
    ageField.handleChange(42)
    form['~'].flush()
    await Promise.resolve()
    form['~'].flush()
    expect(nestedField.errors).toEqual(['Invalid input: expected string, received null'])
    form['~'].flush()
    expect(ageField.errors).toBeUndefined()
    form['~'].flush()
    expect(form.errors?.length).toBeDefined()

    form.data.array![0]!.name = 'John'
    form['~'].flush()
    await Promise.resolve()
    form['~'].flush()
    expect(nestedField.errors).toBeUndefined()
    form['~'].flush()
    expect(ageField.errors).toBeUndefined()
    form['~'].flush()
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
    await Promise.resolve()
    form['~'].flush()
    expect(field.errors).toBeDefined()

    field.handleChange(0)
    form['~'].flush()
    field.handleBlur()
    await Promise.resolve()
    form['~'].flush()
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

    form['~'].flush()
    expect(field.value).toStrictEqual('2025-01-01')
    form['~'].flush()
    expect(fieldT.value).toStrictEqual(new Date('2025-01-01'))

    let now = new Date()
    fieldT.handleChange(now)

    form['~'].flush()
    expect(fieldT.value).toEqual(now)
    form['~'].flush()
    expect(field.value).toBe(now.toISOString())
    form['~'].flush()
    expect(form.data.date).toBe(now.toISOString())

    now = new Date(+now + 1)
    field.handleChange(now.toISOString())

    form['~'].flush()
    expect(fieldT.value).toEqual(now)
    form['~'].flush()
    expect(field.value).toBe(now.toISOString())
    form['~'].flush()
    expect(form.data.date).toBe(now.toISOString())
  })

  test('discriminator', async () => {
    const loadedData = {
      union: {
        type: 'A' as const,
        value: 'Hello',
      },
    }
    const data = ref<typeof loadedData>()

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
      sourceValues() {
        return data.value
      },
      async submit() {},
    })

    const unionField = form.fields.union.$use({ discriminator: 'type' })

    form['~'].flush()
    expect(unionField.type).toBeNull()
    form['~'].flush()
    expect(unionField.$field.$use().value).toEqual(null)
    if (unionField.type === null) {
      form['~'].flush()
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
    data.value = loadedData

    form['~'].flush()
    expect('type' in unionField.$field).toBe(true)
    form['~'].flush()
    expect('notFound' in unionField.$field).toBe(false)

    form['~'].flush()
    expect(unionField.$field.$use().value).toEqual({ type: 'A', value: 'Hello' })
    if (unionField.type === 'A') {
      form['~'].flush()
      expectTypeOf(unionField.$field.$use().value).toEqualTypeOf<{
        type: 'A' | null
        value: string | null
      } | null>()
    }

    if (form.data) form.data.union = { type: 'B', value: 42 }
    form['~'].flush()
    expect(unionField.$field.$use().value).toEqual({ type: 'B', value: 42 })
    if (unionField.type === 'B') {
      form['~'].flush()
      expectTypeOf(unionField.$field.$use().value).toEqualTypeOf<{
        type: 'B' | null
        value: number | null
      } | null>()
    }
  })

  test('sourceValues is undefined', async () => {
    const isLoading = ref(true)

    const form = useFormCore({
      schema: z.object({
        person: z.object({
          name: z.string(),
        }),
      }),
      sourceValues() {
        if (isLoading.value) return

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
    form['~'].flush()
    expect(nameField.isPending).toBe(true)
    form['~'].flush()
    expect(form.isLoading).toBe(true)
    form['~'].flush()
    expect(form.data?.person).toBeUndefined()
    form['~'].flush()
    expect(nameField.value).toBeNull()

    nameField.handleChange('Input is ignored')
    form['~'].flush()
    expect(nameField.value).toBeNull()

    isLoading.value = false
    form['~'].flush()
    expect(nameField.isPending).toBe(false)
    form['~'].flush()
    expect(form.isLoading).toBe(false)

    form['~'].flush()
    expect(nameField.value).toBe('John Doe')
    form['~'].flush()
    expect(form.data?.person?.name).toBe('John Doe')

    const submit = form.submit()

    await vi.waitFor(() => expect(form.isLoading).toBe(true))
    form['~'].flush()
    expect(form.isLoading).toBe(true)
    form['~'].flush()
    expect(nameField.isPending).toBe(false) // pending is only for loading source values

    await submit

    form['~'].flush()
    expect(form.isLoading).toBe(false)
    form['~'].flush()
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
      form['~'].flush()
      expect(stringField.value).toBeNull()

      stringField.handleChange('Test')

      form['~'].flush()
      expect(stringField.value).toBe('Test')
      form['~'].flush()
      expect(form.data['foo.bar']).toBe('Test')
      form['~'].flush()
      expect(stringField.path).toBe(String.raw`foo\.bar`)

      // array (has special cache handling)
      const arrayField = form.fields['foo.bar.array'].at(0).$use()
      form['~'].flush()
      expect(arrayField.value).toBe('one')
      form['~'].flush()
      expect(form.data['foo.bar.array']?.[0]).toEqual('one')

      form.data['foo.bar.array']?.unshift('zero')

      form['~'].flush()
      expect(form.data['foo.bar.array']?.[0]).toEqual('zero')
      form['~'].flush()
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
      form['~'].flush()
      expect(arrayField.value).toBe('one')
      form['~'].flush()
      expect(form.data.array?.[0]).toEqual('one')

      form.data.array?.unshift('zero')

      form['~'].flush()
      expect(form.data.array?.[0]).toEqual('zero')
      form['~'].flush()
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

      form['~'].flush()
      expect(form.fields.$use().value.name).toEqual('John')
      form['~'].flush()
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
        form['~'].flush()
        expect(values).toEqual({ name: 'John' })
      },
    })

    let result = await form.submit()

    form['~'].flush()
    expect(result.success).toBe(true)
    form['~'].flush()
    expect(beforeSubmitSpy).toHaveBeenCalledWith({ data: { name: 'John' } })
    form['~'].flush()
    expect(afterSubmitSpy).toHaveBeenCalledWith({ success: true })
    form['~'].flush()
    expect(beforeSubmitSpy).toHaveBeenCalledBefore(afterSubmitSpy)

    // @ts-expect-error test validation
    form.data.name = 2

    result = await form.submit()

    form['~'].flush()
    expect(result.success).toBe(false)
    form['~'].flush()
    expect(beforeSubmitSpy).toHaveBeenNthCalledWith(2, { data: { name: 2 } })
    form['~'].flush()
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

    form['~'].flush()
    expect(beforeValidateSpy).toHaveBeenCalled()
    form['~'].flush()
    expect(afterValidateSpy).toHaveBeenCalledWith({ value: { name: 'John' } })
    form['~'].flush()
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

    form['~'].flush()
    expect(beforeFieldChangeSpy).toHaveBeenCalledWith(field, 'Jane')
    form['~'].flush()
    expect(afterFieldChangeSpy).toHaveBeenCalledWith(field, 'Jane')
    form['~'].flush()
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

    form['~'].flush()
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

    form['~'].flush()
    expect(a2.value).toBeNull()
    form['~'].flush()
    expect(form.data.items).toEqual([])

    const items = form.fields.items.$use()
    items.handleChange([
      { a: '1', b: 1 },
      { a: '2', b: 2 },
      { a: '3', b: 3 },
    ])
    form['~'].flush()
    expect(a2.value).toBe('3')

    // Fields materialized before data arrives bind to the arriving parent.
    form['~'].flush()
    expect(form.fields.items.at(2)?.a.$use().key).toBe(a2PrevKey)

    form['~'].flush()
    expect(form.data.items).toEqual([
      { a: '1', b: 1 },
      { a: '2', b: 2 },
      { a: '3', b: 3 },
    ])

    form['~'].flush()
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
})

describe('array identity', () => {
  const schema = z.object({
    rows: z.array(z.object({ id: z.number(), name: z.string().min(1) })),
    tags: z.array(z.string()),
  })
  const sourceValues = {
    rows: [
      { id: 1, name: 'one' },
      { id: 2, name: 'two' },
      { id: 3, name: 'three' },
    ],
    tags: ['a', 'b'],
  }
  const create = () => useFormCore({ schema, sourceValues, async submit() {} })

  test('object fields and children retain identity, errors and dirty state after reordering', async () => {
    const form = create()
    const row = form.fields.rows.at(0).$use()
    const name = form.fields.rows.at(0).name.$use()
    name.handleChange('')
    form['~'].flush()
    await form.submit()
    const errors = name.errors
    expect(errors).toBeDefined()
    form.data.rows!.reverse()
    form['~'].flush()
    expect(form.fields.rows.at(2).$use()).toBe(row)
    expect(form.fields.rows.at(2).name.$use()).toBe(name)
    expect(name.isDirty).toBe(true)
    expect(name.errors).toEqual(errors)
    expect(name.path).toBe('rows[2].name')
    name.handleChange('moved')
    form['~'].flush()
    expect(form.data.rows![2]!.name).toBe('moved')
    form.fields.rows.delete(row.key)
    form['~'].flush()
    expect(form.data.rows!.map((row) => row!.id)).toEqual([3, 2])
  })

  test.each([
    'splice',
    'sort',
    'reverse',
    'unshift',
    'pop',
    'shift',
    'push',
    'fill',
    'copyWithin',
    'move',
  ] as const)('%s keeps surviving object fields', (method) => {
    const form = create()
    const originals = new Map(
      form.data.rows!.map((row, i) => [row!.id, form.fields.rows.at(i).$use()]),
    )
    form.setData((draft) => {
      const rows = draft.rows!
      switch (method) {
        case 'splice':
          rows.splice(1, 1, { id: 4, name: 'four' })
          break
        case 'sort':
          rows.sort((a, b) => b!.id! - a!.id!)
          break
        case 'reverse':
          rows.reverse()
          break
        case 'unshift':
          rows.unshift({ id: 4, name: 'four' }, { id: 5, name: 'five' })
          break
        case 'pop':
          rows.pop()
          break
        case 'shift':
          rows.shift()
          break
        case 'push':
          rows.push({ id: 4, name: 'four' })
          break
        case 'fill':
          rows.fill({ id: 4, name: 'four' }, 0, 2)
          break
        case 'copyWithin':
          rows.copyWithin(0, 1, 2)
          break
        case 'move':
          rows.splice(2, 0, rows.splice(0, 1)[0]!)
          break
      }
    })
    form['~'].flush()
    for (const [i, row] of form.data.rows!.entries()) {
      const original = originals.get(row!.id)
      if (original) expect(form.fields.rows.at(i).$use()).toBe(original)
    }
  })

  test('primitive fields are positional and reset preserves current positions', () => {
    const form = create()
    const tag = form.fields.tags.at(0).$use()
    const row = form.fields.rows.at(0).$use()
    tag.handleChange('edited')
    form.data.tags!.reverse()
    form['~'].flush()
    expect(form.fields.tags.at(0).$use()).toBe(tag)
    expect(tag.value).toBe('b')
    expect(tag.isDirty).toBe(true)
    form.reset()
    form['~'].flush()
    expect(form.fields.rows.at(0).$use()).toBe(row)
    expect(form.fields.tags.at(0).$use()).toBe(tag)
    expect(form.data).toEqual(sourceValues)
    expect(form.isDirty).toBe(false)
    expect(tag.isDirty).toBe(false)
  })

  test('setData batches all changes into one whole-schema validation', async () => {
    const validate = vi.spyOn(schema['~standard'], 'validate')
    const form = create()
    const listener = vi.fn()
    form['~'].subscribe(listener)
    form.setData((draft) => {
      draft.rows![0]!.name = 'changed'
      draft.tags!.push('c')
      draft.rows!.reverse()
    })
    form['~'].flush()
    await Promise.resolve()
    expect(validate).toHaveBeenCalledTimes(1)
    expect(validate.mock.calls[0]![0]).toEqual({
      rows: [
        { id: 3, name: 'three' },
        { id: 2, name: 'two' },
        { id: 1, name: 'changed' },
      ],
      tags: ['a', 'b', 'c'],
    })
    expect(listener).toHaveBeenCalled()
    validate.mockRestore()
  })

  test('keyed source refresh preserves rows while reset is positional', () => {
    const [source, setSource] = createSignal(sourceValues)
    const form = useFormCore({ schema, sourceValues: source, key: 'id', async submit() {} })
    const first = form.fields.rows.at(0).$use()
    setSource({ ...sourceValues, rows: [...sourceValues.rows].reverse() })
    form['~'].flush()
    expect(form.fields.rows.at(2).$use()).toBe(first)
    expect(form.isDirty).toBe(false)
    form.data.rows!.reverse()
    form['~'].flush()
    expect(form.fields.rows.at(0).$use()).toBe(first)
    form.reset()
    form['~'].flush()
    expect(form.fields.rows.at(0).$use()).toBe(first)
    expect(first.value!.id).toBe(3)
  })

  test('opaque values remain leaves and validation receives plain schema data', async () => {
    class Value {
      constructor(readonly text: string) {}
    }
    const file = new File(['contents'], 'test.txt')
    const value = new Value('opaque')
    const form = useFormCore({
      schema: z.object({ file: z.custom<File>(), value: z.custom<Value>() }),
      sourceValues: { file, value },
      async submit({ values }) {
        expect(values.file).toBe(file)
        expect(values.value).toBe(value)
      },
    })
    expect(form.fields.file.$use().value).toBe(file)
    expect(form.fields.value.$use().value).toBe(value)
    expect(await form.submit()).toEqual({ success: true })
  })
})

test('missing optional children follow their parent and blur only reveals the edited field', async () => {
  const form = useFormCore({
    schema: z.object({
      rows: z.array(z.object({ id: z.number(), name: z.string().min(2).optional() })),
      sibling: z.string().min(2),
    }),
    sourceValues: { rows: [{ id: 1 }, { id: 2 }], sibling: '' },
    async submit() {},
  })
  const name = form.fields.rows.at(0).name.$use()
  const sibling = form.fields.sibling.$use()
  form.data.rows!.reverse()
  form['~'].flush()
  expect(form.fields.rows.at(1).name.$use()).toBe(name)
  name.handleChange('x')
  form['~'].flush()
  name.handleBlur()
  await Promise.resolve()
  form['~'].flush()
  expect(name.errors).toBeDefined()
  expect(sibling.errors).toBeUndefined()
  expect(form.data.rows![1]!.name).toBe('x')
})

test('handleChange preserves opaque replacements and counts unchanged input events as edits', () => {
  class Value {
    #text = 'opaque'
    read() {
      return this.#text
    }
  }
  const original = new Value()
  const form = useFormCore({
    schema: z.object({ value: z.custom<Value>() }),
    sourceValues: { value: original },
    async submit() {},
  })
  const field = form.fields.value.$use()
  field.handleChange(original)
  form['~'].flush()
  expect(form.isDirty).toBe(true)
  expect(field.isDirty).toBe(true)
  const next = new Value()
  field.handleChange(next)
  form['~'].flush()
  expect(field.value).toBe(next)
  expect(field.value!.read()).toBe('opaque')
})

test('source refresh cannot overwrite edits in its batch or hide later edits', () => {
  const [source, setSource] = createSignal({ name: 'original' })
  const form = useFormCore({
    schema: z.object({ name: z.string() }),
    sourceValues: source,
    async submit() {},
  })
  form.data.name = 'edited'
  setSource({ name: 'server' })
  form['~'].flush()
  expect(form.data.name).toBe('edited')
  expect(form.isDirty).toBe(true)
  form.reset()
  setSource({ name: 'refreshed' })
  form['~'].flush()
  expect(form.isDirty).toBe(false)
  form.data.name = 'later edit'
  form['~'].flush()
  expect(form.isDirty).toBe(true)
})

test('a missing intermediate object stays anchored to its existing row', () => {
  const form = useFormCore({
    schema: z.object({
      rows: z.array(z.object({ id: z.number(), user: z.object({ name: z.string() }).optional() })),
    }),
    sourceValues: { rows: [{ id: 1 }, { id: 2 }] },
    async submit() {},
  })
  const name = form.fields.rows.at(0).user.name.$use()
  form.data.rows!.reverse()
  form['~'].flush()
  expect(name.path).toBe('rows[1].user.name')
  name.handleChange('Alice')
  form['~'].flush()
  expect(form.data.rows![1]!.user!.name).toBe('Alice')
  expect(form.fields.rows.at(1).user.name.$use()).toBe(name)
})

test('deleting the last array index preserves the validation input length', async () => {
  const submit = vi.fn(async () => {})
  const form = useFormCore({
    schema: z.object({ tags: z.array(z.string()) }),
    sourceValues: { tags: ['a', 'b'] },
    submit,
  })
  // eslint-disable-next-line ts/no-array-delete -- Exercise sparse-array validation.
  delete form.data.tags![1]
  form['~'].flush()
  expect(form.data.tags!.length).toBe(2)
  expect(await form.submit()).toEqual({ success: false })
  expect(submit).not.toHaveBeenCalled()
})

test('a removed row with unresolved children cannot edit its replacement', () => {
  const form = useFormCore({
    schema: z.object({
      rows: z.array(z.object({ id: z.number(), user: z.object({ name: z.string() }).optional() })),
    }),
    sourceValues: { rows: [{ id: 1 }, { id: 2, user: { name: 'keep' } }] },
    async submit() {},
  })
  const removed = form.fields.rows.at(0).user.name.$use()
  form.data.rows!.shift()
  form['~'].flush()
  removed.handleChange('wrong row')
  form['~'].flush()
  expect(form.data.rows![0]!.user!.name).toBe('keep')
})

test('source refresh clears submitted errors and changes do not reveal global errors early', async () => {
  const [source, setSource] = createSignal({ name: '' })
  const form = useFormCore({
    schema: z.object({ name: z.string().min(2) }),
    sourceValues: source,
    async submit() {},
  })
  const name = form.fields.name.$use()
  await form.submit()
  expect(name.errors).toBeDefined()
  setSource({ name: 'valid' })
  form['~'].flush()
  expect(form.errors).toBeUndefined()
  expect(name.errors).toBeUndefined()
  name.handleChange('x')
  form['~'].flush()
  await Promise.resolve()
  form['~'].flush()
  expect(form.errors).toBeUndefined()
  expect(name.errors).toBeUndefined()
})
