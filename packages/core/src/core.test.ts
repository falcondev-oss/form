import { createRoot, createSignal, flush } from '@solidjs/signals'
import { type } from 'arktype'
import { Temporal } from 'temporal-polyfill'
import { describe, expect, expectTypeOf, test, vi } from 'vitest'
import z from 'zod'
import { useFormCore } from './core'
import { observe } from './reactive'
import { sleep } from './util'

async function until(condition: () => boolean) {
  while (!condition()) await sleep(1)
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

      expect(form.data.name).toBe('Jane Doe')
      expect(form.isChanged).toBe(true)
    })

    test('replaced File', () => {
      const form = useFormCore({
        schema: z.object({
          file: z.instanceof(File),
        }),
        sourceValues: {
          file: new File(['a'], 'a.txt'),
        },
        async submit() {},
      })
      const field = form.fields.file.$use()

      expect(form.isChanged).toBe(false)
      expect(field.isChanged).toBe(false)

      field.handleChange(new File(['b'], 'b.txt'))

      expect(form.isChanged).toBe(true)
      expect(field.isChanged).toBe(true)
    })

    test('replaced Temporal', () => {
      const form = useFormCore({
        schema: z.object({
          date: z.instanceof(Temporal.PlainDate),
        }),
        sourceValues: {
          date: Temporal.PlainDate.from('2026-11-02'),
        },
        async submit() {},
      })
      const field = form.fields.date.$use()

      expect(form.data.date?.toString()).toBe('2026-11-02')
      expect(form.isChanged).toBe(false)

      field.handleChange(Temporal.PlainDate.from('2026-11-03'))

      expect(form.data.date?.toString()).toBe('2026-11-03')
      expect(form.isChanged).toBe(true)
      expect(field.isChanged).toBe(true)

      field.handleChange(Temporal.PlainDate.from('2026-11-02'))

      expect(form.isChanged).toBe(false)
      expect(field.isChanged).toBe(false)
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

    observe(
      () => form.data.name,
      () => spy(form.data.name),
    )

    form.fields.name.$use().handleChange('Isaac Newton')
    expect(spy).toHaveBeenCalledWith('Isaac Newton')
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
      expect(form.data.name).toBe('Jane Doe')

      setSourceValues({
        name: 'Alice Johnson',
      })
      flush()
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
      expect(form.data.name).toBe('Jane Doe')

      await form.submit()
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
    expect(form.isDirty).toBe(true)

    await form.submit()
    expect(form.isDirty).toBe(false)
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
    flush()
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
    await Promise.resolve()
    expect(nestedField.errors).toEqual(['Invalid input: expected string, received null'])
    expect(ageField.errors).toBeUndefined()
    expect(form.errors?.length).toBeDefined()

    form.data.array![0]!.name = 'John'
    await Promise.resolve()
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
    await Promise.resolve()
    expect(field.errors).toBeDefined()

    field.handleChange(0)
    field.handleBlur()
    await Promise.resolve()
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

    expect(fieldT.value).toEqual(now)
    expect(field.value).toBe(now.toISOString())
    expect(form.data.date).toBe(now.toISOString())

    now = new Date(+now + 1)
    field.handleChange(now.toISOString())

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
    flush()

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
    expect(unionField.$field.$use().value).toEqual({ type: 'B', value: 42 })
    if (unionField.type === 'B') {
      expectTypeOf(unionField.$field.$use().value).toEqualTypeOf<{
        type: 'B' | null
        value: number | null
      } | null>()
    }
  })

  test('root discriminator updates after reset', () => {
    const form = useFormCore({
      schema: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), a: z.string() }),
        z.object({ kind: z.literal('b'), b: z.string() }),
      ]),
      sourceValues: () => ({ kind: 'a' as const, a: 'x' }),
      async submit() {},
    })
    const root = form.fields.$use({ discriminator: 'kind' })

    const seen: unknown[] = [root.kind]
    observe(
      () => root.kind,
      () => seen.push(root.kind),
    )

    form.data.kind = 'b'
    form.reset()
    form.data.kind = 'b'

    expect(seen).toEqual(['a', 'b', 'a', 'b'])
    expect(form.fields.$use().isChanged).toBe(true)
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
    flush()
    expect(nameField.isPending).toBe(false)
    expect(form.isLoading).toBe(false)

    expect(nameField.value).toBe('John Doe')
    expect(form.data?.person?.name).toBe('John Doe')

    const submit = form.submit()

    await until(() => form.isLoading)
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

      expect(stringField.value).toBe('Test')
      expect(form.data['foo.bar']).toBe('Test')
      expect(stringField.path).toBe(String.raw`foo\.bar`)

      // array (has special cache handling)
      const arrayField = form.fields['foo.bar.array'].at(0).$use()
      expect(arrayField.value).toBe('one')
      expect(form.data['foo.bar.array']?.[0]).toEqual('one')

      form.data['foo.bar.array']?.unshift('zero')

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

    const consoleWarnSpy = vi.spyOn(console, 'warn')

    // @ts-expect-error Prevent assignment to readonly property
    form.fields.$use().value = {}
    expect(consoleWarnSpy).toHaveBeenLastCalledWith(
      'useForm:',
      'field.value is readonly, use field.handleChange() instead',
      '()',
    )

    form.fields.$use().value.a = 'new value'
    expect(form.data.a).toBe('new value')
    form.fields.$use().value.obj!.b = 456
    expect(form.data.obj?.b).toBe(456)

    // pushing to array is allowed
    form.fields.array.$use().value?.push('three')
    expect(form.data.array).toEqual(['one', 'two', 'three'])
  })
})

describe('solid', () => {
  test('discriminated union handle narrows reactively', () => {
    const form = useFormCore({
      schema: z.object({
        union: z.discriminatedUnion('type', [
          z.object({ type: z.literal('A'), value: z.string() }),
          z.object({ type: z.literal('B'), value: z.number() }),
        ]),
      }),
      sourceValues: { union: { type: 'A' as const, value: 'x' } },
      async submit() {},
    })
    const union = form.fields.union.$use({ discriminator: 'type' })

    // property reads (not accessor calls) keep TypeScript's narrowing and stay tracked
    const describeUnion = () => {
      if (union.type === 'A') {
        const field = union.$field.value.$use()
        expectTypeOf(field.value).toEqualTypeOf<string | null>()
        return `A:${field.value}`
      }
      if (union.type === 'B') {
        const field = union.$field.value.$use()
        expectTypeOf(field.value).toEqualTypeOf<number | null>()
        return `B:${field.value?.toFixed(1)}`
      }
      return 'empty'
    }

    const seen = [describeUnion()]
    observe(describeUnion, () => seen.push(describeUnion()))

    form.data.union = { type: 'B', value: 2 }
    if (union.type === 'B') union.$field.value.$use().handleChange(3)
    form.fields.union.$use().handleChange(null)

    expect(seen).toEqual(['A:x', 'B:2.0', 'B:3.0', 'empty'])
  })

  test('array mutations keep field keys with their items', () => {
    const form = useFormCore({
      schema: z.object({ items: z.array(z.object({ name: z.string() })) }),
      sourceValues: { items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
      async submit() {},
    })
    const keyAt = (index: number) => form.fields.items.at(index).$use().key
    const names = () => form.data.items?.map((item) => item?.name)
    const [keyA, keyB, keyC] = [keyAt(0), keyAt(1), keyAt(2)]

    form.data.items!.unshift({ name: 'z' })
    expect(names()).toEqual(['z', 'a', 'b', 'c'])
    expect(keyAt(1)).toBe(keyA)

    form.data.items!.reverse()
    expect(names()).toEqual(['c', 'b', 'a', 'z'])
    expect(keyAt(0)).toBe(keyC)

    form.data.items!.sort((x, y) => (x?.name ?? '').localeCompare(y?.name ?? ''))
    expect(names()).toEqual(['a', 'b', 'c', 'z'])
    expect([keyAt(0), keyAt(1), keyAt(2)]).toEqual([keyA, keyB, keyC])

    // keyB was created at index 1, but its item sits at index 1 only by coincidence: move it first
    form.data.items!.splice(0, 1)
    expect(names()).toEqual(['b', 'c', 'z'])
    form.fields.items.delete(keyB)
    expect(names()).toEqual(['c', 'z'])
    expect(keyAt(0)).toBe(keyC)

    expect(form.isDirty).toBe(true)
  })

  test('array iteration is tracked', () => {
    const form = useFormCore({
      schema: z.object({ tags: z.array(z.string()) }),
      sourceValues: { tags: ['a'] },
      async submit() {},
    })
    const lengths: number[] = []
    const count = () => [...form.fields.tags].length
    observe(count, () => lengths.push(count()))

    form.data.tags!.push('b')
    form.fields.tags.$use().value!.push('c')
    form.fields.tags.delete(form.fields.tags.at(0).$use().key)

    expect(lengths).toEqual([2, 3, 2])
  })

  test('$use inside an owned scope', () => {
    let form!: ReturnType<typeof createNameForm>
    let field!: ReturnType<typeof form.fields.name.$use>
    function createNameForm() {
      return useFormCore({
        schema: z.object({ name: z.string() }),
        sourceValues: { name: 'John' },
        async submit() {},
      })
    }

    // e.g. a Solid component body, where reactive writes are not allowed
    const dispose = createRoot((dispose) => {
      form = createNameForm()
      field = form.fields.name.$use()
      form.fields.name.$use({ translate: { get: (v) => v?.length, set: (v) => String(v) } })
      return dispose
    })

    field.handleChange('Jane')
    expect(form.data.name).toBe('Jane')
    expect(field.isDirty).toBe(true)
    dispose()
  })

  test('moved array field re-$use inside an owned scope', () => {
    const form = useFormCore({
      schema: z.object({ tags: z.array(z.string()) }),
      sourceValues: { tags: ['a', 'b'] },
      async submit() {},
    })
    const first = form.fields.tags.at(0).$use()
    form.data.tags!.unshift('z')

    const moved = createRoot(() => form.fields.tags.at(1).$use())

    expect(moved).toBe(first)
    expect(moved.path).toBe('tags[1]')
    expect(moved.value).toBe('a')
  })

  test('writes from an observer callback', () => {
    const form = useFormCore({
      schema: z.object({ a: z.string(), b: z.string() }),
      sourceValues: { a: '', b: '' },
      async submit() {},
    })
    const warn = vi.spyOn(console, 'warn').mockClear()
    observe(
      () => form.data.a,
      () => form.fields.b.$use().handleChange(`${form.data.a}!`),
    )

    form.data.a = 'x'

    expect(form.data.b).toBe('x!')
    expect(warn).not.toHaveBeenCalled()
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
    expect(form.data.items).toEqual([
      { a: '1', b: 1 },
      { a: '2', b: 2 },
    ])
  })
})
