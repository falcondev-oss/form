import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import z from 'zod'
import { useField, useForm } from '.'
import { tick } from './util'

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
        sourceValues: {
          name: 'John Doe',
        },
        async submit() {},
      })
    })

    expect(form.current.fields.name.$use().model.value).toEqual('John Doe')

    expect(renderCount).toEqual(1)
    const previousTick = form.current.fields.name.$use()[tick]

    act(() => {
      form.current.fields.name.$use().model.onUpdate('Jane Doe')
    })

    // check if react component update occurred
    const currentTick = form.current.fields.name.$use()[tick]
    expect(renderCount).toEqual(2)

    expect(previousTick).toBeLessThan(currentTick)

    expect(form.current.fields.name.$use().model.value).toEqual('Jane Doe')
    expect(form.current.data?.name).toEqual('Jane Doe')
  })

  test('useField', async () => {
    const { result: form } = renderHook(() =>
      useForm({
        schema: z.object({
          name: z.string(),
        }),
        sourceValues: {
          name: 'John Doe',
        },
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

    act(() => {
      form.current.fields.password.$use().model.onUpdate('123456')
    })
    expect(form.current.data.password).toEqual('123456')

    let submitPromise!: Promise<unknown>
    act(() => {
      submitPromise = form.current.submit()
    })

    // wait until the submit handler is running
    await submitEntered.promise

    // new sourceValues arrive mid-submit (e.g. a refetch resolving) -> must be ignored,
    // because the form is dirty and a submit is already in flight
    act(() => {
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

  test('data writes rerender after flush', async () => {
    let renderCount = 0
    const { result: form } = renderHook(() => {
      renderCount++
      return useForm({
        schema: z.object({
          name: z.string(),
        }),
        sourceValues: {
          name: 'John Doe',
        },
        async submit() {},
      })
    })

    await act(async () => {
      form.current.data.name = 'Jane Doe'
    })

    expect(renderCount).toEqual(2)
    expect(form.current.data.name).toEqual('Jane Doe')
    expect(form.current.isChanged).toBe(true)
  })
})
