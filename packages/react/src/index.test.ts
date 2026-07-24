import { useFormCore } from '@falcondev-oss/form-core'
import { createSignal } from '@solidjs/signals'
import { createElement } from 'react'
import { create } from 'react-test-renderer'
import { describe, expect, test, vi } from 'vitest'
import z from 'zod'
import { useField, useForm } from '.'

describe('react', () => {
  test('model updates the form and re-renders', async () => {
    const schema = z.object({ name: z.string() })
    let form!: ReturnType<typeof useForm<typeof schema>>
    let renders = 0

    function Component() {
      form = useForm({
        schema,
        sourceValues: { name: 'John Doe' },
        async submit() {},
      })
      renders++
      return null
    }

    create(createElement(Component))
    await vi.waitFor(() => expect(renders).toBeGreaterThan(0))
    const initialRenders = renders
    form.fields.name.$use().model.onUpdate('Jane Doe')
    form['~'].flush()

    await vi.waitFor(() => expect(renders).toBeGreaterThan(initialRenders))
    expect(form.fields.name.$use().model.value).toBe('Jane Doe')
    expect(form.data!.name).toBe('Jane Doe')
  })

  test('useField re-renders for field changes', async () => {
    const form = useFormCore({
      schema: z.object({ name: z.string() }),
      sourceValues: { name: 'John Doe' },
      async submit() {},
    })
    const field = form.fields.name.$use()
    let renders = 0

    function Component() {
      useField(field)
      renders++
      return null
    }

    create(createElement(Component))
    await vi.waitFor(() => expect(renders).toBeGreaterThan(0))
    const initialRenders = renders
    field.handleChange('Jane Doe')
    form['~'].flush()

    await vi.waitFor(() => expect(renders).toBeGreaterThan(initialRenders))
    expect(field.value).toBe('Jane Doe')
  })

  test('useField re-renders for field-only dirty state changes', async () => {
    const form = useFormCore({
      schema: z.object({ name: z.string() }),
      sourceValues: { name: 'John Doe' },
      async submit() {},
    })
    const field = form.fields.name.$use()
    let dirty = false

    function Component() {
      useField(field)
      dirty = field.isDirty
      return null
    }

    create(createElement(Component))
    field.handleChange('John Doe')
    await vi.waitFor(() => expect(dirty).toBe(true))

    field.reset()
    await vi.waitFor(() => expect(dirty).toBe(false))
  })

  test('source getter updates flow into a pristine form', async () => {
    const schema = z.object({ name: z.string() })
    const [sourceValues, setSourceValues] = createSignal({ name: 'John Doe' })
    let form!: ReturnType<typeof useForm<typeof schema>>

    function Component() {
      form = useForm({
        schema,
        sourceValues,
        async submit() {},
      })
      return null
    }

    create(createElement(Component))
    await vi.waitFor(() => expect(form.data!.name).toBe('John Doe'))
    setSourceValues({ name: 'Jane Doe' })
    form['~'].flush()

    await vi.waitFor(() => expect(form.data!.name).toBe('Jane Doe'))
  })
})
