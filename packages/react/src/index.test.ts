import { act, render, renderHook } from '@testing-library/react'
import { createElement, useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import z from 'zod'
import { FormFieldMemo, useField, useForm } from '.'

type Deferred = { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('react', () => {
  test('model', async () => {
    let renderCount = 0
    const { result: form } = renderHook(() => {
      renderCount++
      return useForm({
        schema: z.object({
          name: z.string(),
        }),
        sourceValues: () => ({
          name: 'John Doe',
        }),
        async submit() {},
      })
    })

    expect(form.current.fields.name.$use().model.value).toEqual('John Doe')

    expect(renderCount).toEqual(1)

    await act(async () => {
      form.current.fields.name.$use().model.onUpdate('Jane Doe')
    })

    // check if react component update occurred
    expect(renderCount).toEqual(2)

    expect(form.current.fields.name.$use().model.value).toEqual('Jane Doe')
    expect(form.current.data?.name).toEqual('Jane Doe')
  })

  test('useField', async () => {
    const { result: form } = renderHook(() =>
      useForm({
        schema: z.object({
          name: z.string(),
        }),
        sourceValues: () => ({
          name: 'John Doe',
        }),
        async submit() {},
      }),
    )
    expect(form.current.fields.name.$use().value).toEqual('John Doe')

    const nameField = form.current.fields.name.$use()
    let renderCount = 0
    renderHook(() => {
      renderCount++
      useField(nameField)
    })
    expect(renderCount).toEqual(1)

    await act(async () => {
      nameField.handleChange('Jane Doe')
    })

    // check if react component update occurred
    expect(renderCount).toEqual(2)
  })

  // https://github.com/falcondev-oss/form/issues/8
  test('sourceValues update during failed submit does not trigger reset', async () => {
    // blocks the submit handler until the test releases it
    const submitGate = deferred()
    const submitEntered = deferred()

    const submit = vi.fn(async () => {
      submitEntered.resolve()
      await submitGate.promise
      return { success: false }
    })

    let setSourceValues!: (values: { password: string | null }) => void

    const { result: form } = renderHook(() => {
      const [sourceValues, setValues] = useState<{ password: string | null }>({ password: null })
      setSourceValues = setValues

      return useForm({
        schema: z.object({
          password: z.string().min(1),
        }),
        sourceValues,
        submit,
      })
    })

    await act(async () => {
      form.current.fields.password.$use().model.onUpdate('123456')
    })
    expect(form.current.data.password).toEqual('123456')

    let submitPromise!: Promise<unknown>
    await act(async () => {
      submitPromise = form.current.submit()
    })

    // wait until the submit handler is running
    await submitEntered.promise

    // new sourceValues arrive mid-submit (e.g. a refetch resolving) -> must be ignored,
    // because the form is dirty and a submit is already in flight
    await act(async () => {
      setSourceValues({ password: 'mid-submit' })
    })
    expect(form.current.data.password).toEqual('123456')

    submitGate.resolve()
    await act(async () => {
      await submitPromise
    })

    // after a failed submit, the data should be kept, not reset
    expect(form.current.data.password).toEqual('123456')
  })

  test('direct writes rerender the form owner', async () => {
    const sourceValues = { name: 'John Doe' }
    const { result } = renderHook(() => {
      const form = useForm({
        schema: z.object({ name: z.string() }),
        sourceValues,
        async submit() {},
      })
      return { form, name: form.data.name, changed: form.isChanged }
    })
    await act(async () => {
      result.current.form.data.name = 'Jane Doe'
    })
    expect(result.current.name).toBe('Jane Doe')
    expect(result.current.changed).toBe(true)
  })
})

test('memoized field components update for field edits and their own props', async () => {
  const sourceValues = { name: 'John' }
  const { result } = renderHook(() =>
    useForm({ schema: z.object({ name: z.string() }), sourceValues, async submit() {} }),
  )
  const Field = FormFieldMemo<string, { label: string }>(({ field, label }) =>
    createElement('output', null, `${label}: ${field.value}`),
  )
  const field = result.current.fields.name.$use()
  const view = render(createElement(Field, { field, label: 'Name' }))
  expect(view.getByText('Name: John')).toBeDefined()
  await act(async () => {
    field.handleChange('Jane')
  })
  expect(view.getByText('Name: Jane')).toBeDefined()
  view.rerender(createElement(Field, { field, label: 'Changed' }))
  expect(view.getByText('Changed: Jane')).toBeDefined()
})
