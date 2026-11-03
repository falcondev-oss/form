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

    test('stays true until every change is undone', () => {
      const form = useFormCore({
        schema: z.object({
          rows: z.array(z.object({ name: z.string(), tags: z.array(z.string()) })),
        }),
        sourceValues: {
          rows: [
            { name: 'a', tags: ['x'] },
            { name: 'b', tags: [] },
          ],
        },
        async submit() {},
      })
      const root = form.fields.$use()
      const rows = form.fields.rows.$use()
      const seen: boolean[] = []
      observe(
        () => form.isChanged,
        () => seen.push(form.isChanged),
      )

      form.setData((d) => {
        d.rows![1]!.name = 'b2'
      })
      form.setData((d) => {
        d.rows![0]!.tags!.push('y')
      })
      form.setData((d) => {
        d.rows![1]!.name = 'b'
      })
      expect([form.isChanged, root.isChanged, rows.isChanged]).toEqual([true, true, true])

      form.setData((d) => {
        d.rows![0]!.tags!.pop()
      })
      expect([form.isChanged, root.isChanged, rows.isChanged]).toEqual([false, false, false])

      form.setData((d) => {
        d.rows![0]!.tags![0] = 'z'
      })
      expect([form.isChanged, root.isChanged, rows.isChanged]).toEqual([true, true, true])
      expect(seen).toEqual([true, false, true])
    })

    test('nested keys count both ways, File by identity', () => {
      const file = new File(['a'], 'a.txt')
      const form = useFormCore({
        schema: z.object({ meta: z.record(z.string(), z.unknown()) }),
        sourceValues: { meta: { file, note: undefined } as Record<string, unknown> },
        async submit() {},
      })
      const meta = form.fields.meta.$use()

      form.setData((d) => {
        delete d.meta!.note
      })
      expect([form.isChanged, meta.isChanged]).toEqual([true, true])

      form.setData((d) => {
        d.meta!.note = undefined
      })
      expect([form.isChanged, meta.isChanged]).toEqual([false, false])

      form.setData((d) => {
        d.meta!.extra = 1
      })
      expect([form.isChanged, meta.isChanged]).toEqual([true, true])

      form.setData((d) => {
        delete d.meta!.extra
        d.meta!.file = new File(['a'], 'a.txt')
      })
      expect([form.isChanged, meta.isChanged]).toEqual([true, true])

      form.setData((d) => {
        d.meta!.file = file
      })
      expect([form.isChanged, meta.isChanged]).toEqual([false, false])
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

      form.setData((d) => {
        d.name = 'Jane Doe'
      })
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
      form.setData((d) => {
        d.name = 'Jane Doe'
      })
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

    form.setData((d) => {
      d.name = 'Jane Doe'
    })
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

    form.setData((d) => {
      d.array![0]!.name = 'John'
    })
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

    form.setData((d) => {
      d.union = { type: 'B', value: 42 }
    })
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

    form.setData((d) => {
      d.kind = 'b'
    })
    form.reset()
    form.setData((d) => {
      d.kind = 'b'
    })

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

      // array items under an escaped key
      const arrayField = form.fields['foo.bar.array'].at(0).$use()
      expect(arrayField.value).toBe('one')
      expect(form.data['foo.bar.array']?.[0]).toEqual('one')

      form.setData((d) => {
        d['foo.bar.array']?.unshift('zero')
      })

      expect(form.data['foo.bar.array']?.[0]).toEqual('zero')
      // the field stays with its item
      expect(arrayField.value).toBe('one')
      expect(arrayField.path).toBe(String.raw`foo\.bar\.array[1]`)
      expect(form.fields['foo.bar.array'].at(0).$use().value).toBe('zero')
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

      form.setData((d) => {
        d.array?.unshift('zero')
      })

      expect(form.data.array?.[0]).toEqual('zero')
      // the field stays with its item, the accessor resolves the position again
      expect(arrayField.value).toBe('one')
      expect(arrayField.path).toBe('array[1]')
      expect(form.fields.array.at(0).$use().value).toBe('zero')
      expect(form.fields.array.at(1).$use()).toBe(arrayField)
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

    // nested values are readonly too (Solid's dev build warns)
    form.fields.$use().value.a = 'new value'
    form.fields.$use().value.obj!.b = 456
    form.fields.array.$use().value?.push('three')
    expect(form.data).toEqual({ a: 'initial', array: ['one', 'two'], obj: { b: 123 } })
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

    form.setData((d) => {
      d.union = { type: 'B', value: 2 }
    })
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

    form.setData((d) => {
      d.items!.unshift({ name: 'z' })
    })
    expect(names()).toEqual(['z', 'a', 'b', 'c'])
    expect(keyAt(1)).toBe(keyA)

    form.setData((d) => {
      d.items!.reverse()
    })
    expect(names()).toEqual(['c', 'b', 'a', 'z'])
    expect(keyAt(0)).toBe(keyC)

    form.setData((d) => {
      d.items!.sort((x, y) => (x?.name ?? '').localeCompare(y?.name ?? ''))
    })
    expect(names()).toEqual(['a', 'b', 'c', 'z'])
    expect([keyAt(0), keyAt(1), keyAt(2)]).toEqual([keyA, keyB, keyC])

    // keyB was created at index 1, but its item sits at index 1 only by coincidence: move it first
    form.setData((d) => {
      d.items!.splice(0, 1)
    })
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

    form.setData((d) => {
      d.tags!.push('b')
    })
    form.setData((d) => {
      d.tags!.push('c')
    })
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
    form.setData((d) => {
      d.tags!.unshift('z')
    })

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

    form.setData((d) => {
      d.a = 'x'
    })

    expect(form.data.b).toBe('x!')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('item identity', () => {
  const rowsSchema = z.object({
    rows: z.array(z.object({ id: z.number().optional(), name: z.string().min(1) })),
  })
  type Rows = { rows: { id?: number; name: string | null }[] }
  const names = (form: { data: unknown }) => (form.data as Rows).rows.map((row) => row.name)

  test('errors stay with their item when the list is reordered', async () => {
    const form = useFormCore({
      schema: rowsSchema,
      sourceValues: { rows: [{ name: 'a' }, { name: '' }] },
      async submit() {},
    })
    const invalid = form.fields.rows.at(1).name.$use()

    await form.submit()
    expect(invalid.errors).toHaveLength(1)
    expect(form.errors?.[0]?.path).toEqual(['rows', 1, 'name'])

    form.setData((d) => {
      d.rows!.unshift({ name: 'new' })
    })

    expect(invalid.errors).toHaveLength(1)
    expect(invalid.path).toBe('rows[2].name')
    expect(form.fields.rows.at(1).name.$use().errors).toBeUndefined()
    expect(form.errors?.[0]?.path).toEqual(['rows', 2, 'name'])
  })

  test('a removed item detaches its fields', () => {
    const form = useFormCore({
      schema: rowsSchema,
      sourceValues: { rows: [{ name: 'a' }, { name: 'b' }] },
      async submit() {},
    })
    const first = form.fields.rows.at(0).name.$use()
    const warn = vi.spyOn(console, 'warn').mockClear()

    form.setData((d) => {
      d.rows!.shift()
    })

    expect(first.isDetached).toBe(true)
    expect(first.value).toBe('a') // last value
    first.handleChange('late write')
    expect(names(form)).toEqual(['b'])
    expect(warn).toHaveBeenCalledWith(
      'useForm:',
      'handleChange() was ignored, the array item of this field was removed',
      '(rows[0].name)',
    )
  })

  test('items match by id when the source values are refreshed', () => {
    const [source, setSource] = createSignal<Rows>({
      rows: [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
      ],
    })
    const form = useFormCore({ schema: rowsSchema, sourceValues: source, async submit() {} })
    const second = form.fields.rows.at(1).$use()

    setSource({
      rows: [
        { id: 3, name: 'c' },
        { id: 2, name: 'b2' },
        { id: 1, name: 'a' },
      ],
    })
    flush()

    expect(second.path).toBe('rows[1]')
    expect(second.value?.name).toBe('b2')
    expect(form.fields.rows.at(2).$use().key).not.toBe(second.key)
    expect(form.fields.rows.at(1).$use()).toBe(second)
  })

  test('items without id match by position on replace', () => {
    const form = useFormCore({
      schema: rowsSchema,
      sourceValues: { rows: [{ name: 'a' }, { name: 'b' }] },
      async submit() {},
    })
    const second = form.fields.rows.at(1).name.$use()

    form.fields.rows.$use().handleChange([{ name: 'x' }, { name: 'y' }, { name: 'z' }])

    expect(second.isDetached).toBe(false)
    expect(second.value).toBe('y')
  })

  test('custom itemKey', () => {
    const form = useFormCore({
      schema: z.object({ rows: z.array(z.object({ uuid: z.string(), name: z.string() })) }),
      sourceValues: { rows: [{ uuid: 'u1', name: 'a' }] },
      itemKey: 'uuid',
      async submit() {},
    })
    const row = form.fields.rows.at(0).$use()

    form.setData((d) => {
      d.rows = [
        { uuid: 'u2', name: 'b' },
        { uuid: 'u1', name: 'a2' },
      ]
    })

    expect(row.path).toBe('rows[1]')
    expect(row.value?.name).toBe('a2')
  })

  test('a field used before its data loads binds to the loaded item', () => {
    const [source, setSource] = createSignal<Rows>()
    const form = useFormCore({ schema: rowsSchema, sourceValues: source, async submit() {} })
    const first = form.fields.rows.at(0).name.$use()
    expect(first.value).toBeNull()

    setSource({ rows: [{ name: 'a' }, { name: 'b' }] })
    flush()
    expect(first.value).toBe('a')

    form.setData((d) => {
      d.rows!.reverse()
    })
    expect(first.value).toBe('a')
    expect(first.path).toBe('rows[1].name')
  })

  test('at(-1) is the last item when used', () => {
    const form = useFormCore({
      schema: z.object({ tags: z.array(z.string()) }),
      sourceValues: { tags: ['a', 'b'] },
      async submit() {},
    })
    const last = form.fields.tags.at(-1)

    expect(last.$use().value).toBe('b')
    form.setData((d) => {
      d.tags!.push('c')
    })
    expect(last.$use().value).toBe('c')
  })

  test('data proxies of items follow their item', () => {
    const form = useFormCore({
      schema: rowsSchema,
      sourceValues: { rows: [{ name: 'a' }] },
      async submit() {},
    })
    const row = form.data.rows![0]!

    form.setData((d) => {
      d.rows!.unshift({ name: 'z' })
    })
    form.fields.rows.at(1).name.$use().handleChange('a2')

    expect(row.name).toBe('a2')
    expect(names(form)).toEqual(['z', 'a2'])
  })

  test('nested arrays keep their item keys when the outer item moves', () => {
    const form = useFormCore({
      schema: z.object({
        rows: z.array(z.object({ name: z.string(), tags: z.array(z.string()) })),
      }),
      sourceValues: {
        rows: [
          { name: 'a', tags: ['a1', 'a2'] },
          { name: 'b', tags: ['b1'] },
        ],
      },
      async submit() {},
    })
    const a2 = form.fields.rows.at(0).tags.at(1).$use()
    const rowA = form.data.rows![0]!

    form.setData((d) => {
      d.rows!.reverse()
      d.rows![1]!.tags!.unshift('a0')
    })
    expect([a2.path, a2.value]).toEqual(['rows[1].tags[2]', 'a2'])
    expect(rowA.tags).toEqual(['a0', 'a1', 'a2'])

    a2.handleChange('A2')
    form.fields.rows.$use().handleChange([{ name: 'c', tags: [] }, ...form.data.rows!])
    expect([a2.path, a2.value]).toEqual(['rows[2].tags[2]', 'A2'])

    form.reset()
    expect([a2.path, a2.value]).toEqual(['rows[0].tags[1]', 'a2'])
  })

  test('setData keeps fields with items it moves between and within arrays', () => {
    const form = useFormCore({
      schema: z.object({
        rows: z.array(z.object({ name: z.string() })),
        done: z.array(z.object({ name: z.string() })),
        tags: z.array(z.string()),
      }),
      sourceValues: { rows: [{ name: 'a' }, { name: 'b' }], done: [], tags: ['x', 'y'] },
      async submit() {},
    })
    const b = form.fields.rows.at(1).name.$use()
    const x = form.fields.tags.at(0).$use()
    const y = form.fields.tags.at(1).$use()

    form.setData((d) => {
      d.rows = d.rows!.filter((row) => row!.name !== 'a')
      d.tags!.unshift('w')
    })
    form.setData((d) => {
      d.tags![2] = 'y2'
    })

    expect(b.path).toBe('rows[0].name')
    expect(x.path).toBe('tags[1]')
    // a primitive replaced in place keeps its slot's field
    expect([y.path, y.value]).toEqual(['tags[2]', 'y2'])
  })

  test('isChanged and reset compare an item with its own source value', () => {
    const form = useFormCore({
      schema: rowsSchema,
      sourceValues: { rows: [{ name: 'a' }, { name: 'b' }] },
      async submit() {},
    })
    const rows = form.fields.rows.$use()
    const a = form.fields.rows.at(0).$use()

    form.setData((d) => {
      d.rows!.reverse()
    })
    expect(a.isChanged).toBe(false)
    expect(rows.isChanged).toBe(true)

    form.setData((d) => {
      d.rows!.push({ name: 'c' })
    })
    const added = form.fields.rows.at(2).$use()
    expect(added.isChanged).toBe(true)

    rows.reset()
    expect(names(form)).toEqual(['a', 'b'])
    expect(a.path).toBe('rows[0]')
    expect(added.isDetached).toBe(true)
  })
})

describe('data proxy', () => {
  const createRowsForm = () =>
    useFormCore({
      schema: z.object({
        name: z.string(),
        meta: z.object({ note: z.string() }).nullable(),
        rows: z.array(z.object({ name: z.string() })),
      }),
      sourceValues: { name: 'n', meta: { note: 'x' }, rows: [{ name: 'a' }, { name: 'b' }] },
      async submit() {},
    })

  test('form.data is readonly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warn.mockClear()
    const form = createRowsForm()
    const data = form.data
    const rows = data.rows!

    // @ts-expect-error form.data is readonly
    data.name = 'm'
    // @ts-expect-error form.data is readonly
    rows[0]!.name = 'x'
    // @ts-expect-error form.data is readonly
    rows.push({ name: 'c' })
    delete (data as Record<string, unknown>).meta

    expect(form.data).toEqual({
      name: 'n',
      meta: { note: 'x' },
      rows: [{ name: 'a' }, { name: 'b' }],
    })
    expect(form.isDirty).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('STORE_WRITE_OUTSIDE_SETTER'))
    warn.mockRestore()
  })

  test('a setData that changes nothing is no edit', () => {
    const form = createRowsForm()

    form.setData((d) => {
      /* oxlint-disable no-self-assign -- the no-op write is what this test checks */
      d.name = d.name
      d.meta = d.meta
      /* oxlint-enable no-self-assign */
      d.rows!.push()
      d.rows!.sort((x, y) => (x?.name ?? '').localeCompare(y?.name ?? ''))
      d.rows!.fill({ name: 'a' }, 0, 1)
    })
    expect(form.isDirty).toBe(false)

    form.setData((d) => {
      d.name = 'm'
    })
    expect(form.isDirty).toBe(true)
  })

  test('setData re-validates fields that show errors', async () => {
    const form = useFormCore({
      schema: z.object({ name: z.string().min(2), other: z.string().min(2) }),
      sourceValues: { name: 'n', other: 'o' },
      async submit() {},
    })
    const name = form.fields.name.$use()
    const other = form.fields.other.$use()
    name.handleBlur()
    form.setData((d) => {
      d.name = 'x'
    })
    await sleep(0)
    // blur on an unchanged field does not validate; setData only re-checks shown errors
    expect([name.errors, other.errors]).toEqual([undefined, undefined])

    await form.submit()
    expect(name.errors).toHaveLength(1)
    form.setData((d) => {
      d.name = 'ok'
    })
    await sleep(0)
    expect(name.errors).toBeUndefined()
  })

  test('a proxy keeps showing its node after the node left the form', () => {
    const form = createRowsForm()
    const row = form.data.rows![0]!
    const meta = form.data.meta!

    form.setData((d) => {
      d.rows!.shift()
      d.meta = { note: 'y' }
    })

    expect(row.name).toBe('a')
    expect(form.data.rows!.map((r) => r?.name)).toEqual(['b'])
    // objects outside arrays are updated in place
    expect(meta.note).toBe('y')
  })

  test('array read methods hand out item proxies', () => {
    const form = createRowsForm()
    const rows = form.data.rows!
    form.setData((d) => {
      d.rows = d.rows!.map((row) => ({ name: `${row!.name}2` }))
    })

    expect(rows.find((row) => row?.name === 'b2')).toBe(rows[1])
    expect(rows.map((row) => row?.name)).toEqual(['a2', 'b2'])

    const arrays = new Set<unknown>()
    rows.forEach((_row, _i, array) => arrays.add(array))
    rows.reduce((_acc, _row, _i, array) => arrays.add(array), arrays)
    expect([...arrays]).toEqual([rows])

    expect(rows.includes(rows[1]!)).toBe(true)
    expect(rows.indexOf(rows[1]!)).toBe(1)
    expect([...rows.entries()].map(([i, row]) => `${i}:${row?.name}`)).toEqual(['0:a2', '1:b2'])
    expect(rows.at(-1)).toBe(rows[1])
  })

  test('array read methods are tracked', () => {
    const form = createRowsForm()
    const rows = form.data.rows!
    const joined = () => rows.map((row) => row?.name).join()
    const seen = [joined()]
    observe(joined, () => seen.push(joined()))

    form.fields.rows.at(1).name.$use().handleChange('b2')
    form.setData((d) => {
      d.rows!.push({ name: 'c' })
    })

    expect(seen).toEqual(['a,b', 'a,b2', 'a,b2,c'])
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

    form.setData((d) => {
      // @ts-expect-error test validation
      d.name = 2
    })

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
    // created before its item existed: bound to the first item that appeared there
    expect(a2.value).toBe('3')
    expect(form.fields.items.at(2)?.a.$use().key).toBe(a2PrevKey)

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
