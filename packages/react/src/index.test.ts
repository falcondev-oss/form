import { act, renderHook } from '@testing-library/react-hooks'
import { describe, expect, test } from 'vitest'

import z from 'zod'
import { useField, useForm } from '.'
import { tick } from './util'

describe('react', () => {
  test('model', async () => {
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

    expect(form.current.fields.name.$use().model.value).toEqual('John Doe')

    expect(form.all.length).toEqual(1)
    const previousTick = form.current.fields.name.$use()[tick]

    act(() => {
      form.current.fields.name.$use().model.onUpdate('Jane Doe')
    })

    // check if react component update occurred
    const currentTick = form.current.fields.name.$use()[tick]
    expect(form.all.length).toEqual(2)

    expect(previousTick).toBeLessThan(currentTick)

    expect(form.current.fields.name.$use().model.value).toEqual('Jane Doe')
    expect(form.current.data.name).toEqual('Jane Doe')
  })

  test('useField', async () => {
    const {
      result: { current: form },
    } = renderHook(() =>
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
    expect(form.fields.name.$use().value).toEqual('John Doe')

    const nameField = form.fields.name.$use()
    const { result } = renderHook(() => {
      useField(nameField)
    })
    expect(result.all.length).toEqual(1)

    act(() => {
      nameField.handleChange('Jane Doe')
    })

    // check if react component update occurred
    expect(result.all.length).toEqual(2)
  })
})
