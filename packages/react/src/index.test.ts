import { flush } from '@solidjs/signals'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, test } from 'vitest'
import z from 'zod'
import { useField, useForm } from '.'
import { tick } from './util'

// Minimal hook renderer (RTL react-hooks is unmaintained and RTL 16 pulls the
// removed `react-dom/test-utils` on React 19). Tracks render count and exposes
// the latest hook return.
function renderHook<T>(hook: () => T) {
  const container = document.createElement('div')
  const root = createRoot(container)
  const state = { current: undefined as T, renders: 0 }
  function Comp() {
    state.renders++
    state.current = hook()
    return null
  }
  act(() => root.render(createElement(Comp)))
  return state
}

describe('react', () => {
  test('model', () => {
    const state = renderHook(() =>
      useForm({
        schema: z.object({ name: z.string() }),
        sourceValues: () => ({ name: 'John Doe' }),
        async submit() {},
      }),
    )

    expect(state.current.fields.name.$use().model.value).toEqual('John Doe')
    expect(state.renders).toBe(1)

    const previousTick = state.current.fields.name.$use()[tick]

    act(() => {
      state.current.fields.name.$use().model.onUpdate('Jane Doe')
    })

    // a re-render occurred
    expect(state.renders).toBe(2)
    const currentTick = state.current.fields.name.$use()[tick]
    expect(previousTick).toBeLessThan(currentTick)

    expect(state.current.fields.name.$use().model.value).toEqual('Jane Doe')
    expect(state.current.data?.name).toEqual('Jane Doe')
  })

  test('useField', () => {
    const form = renderHook(() =>
      useForm({
        schema: z.object({ name: z.string() }),
        sourceValues: () => ({ name: 'John Doe' }),
        async submit() {},
      }),
    ).current
    expect(form.fields.name.$use().value).toEqual('John Doe')

    const nameField = form.fields.name.$use()
    const field = renderHook(() => useField(nameField))
    expect(field.renders).toBe(1)

    act(() => {
      nameField.handleChange('Jane Doe')
      flush()
    })

    // useField subscribed the component to the field → it re-rendered
    expect(field.renders).toBe(2)
  })
})
