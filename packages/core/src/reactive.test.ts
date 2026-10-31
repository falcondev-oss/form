import { createSignal, createStore, flush } from '@solidjs/signals'
import { describe, expect, test, vi } from 'vitest'
import { commit, observe, trackDeep } from './reactive'

describe('reactive', () => {
  test('commit applies writes synchronously', () => {
    const [count, setCount] = createSignal(0)

    setCount(1)
    expect(count()).toBe(0) // Solid 2.0 holds writes until the next flush

    commit(() => setCount(2))
    expect(count()).toBe(2)
  })

  test('observe fires once per change and stops', () => {
    const [count, setCount] = createSignal(0)
    const spy = vi.fn()

    const stop = observe(count, () => spy(count()))
    expect(spy).not.toHaveBeenCalled()

    commit(() => setCount(1))
    commit(() => setCount(2))
    expect(spy.mock.calls).toEqual([[1], [2]])

    stop()
    commit(() => setCount(3))
    expect(spy).toHaveBeenCalledTimes(2)
  })

  test('commit inside an observe callback does not flush again', () => {
    const [count, setCount] = createSignal(0)
    const [double, setDouble] = createSignal(0)
    const warn = vi.spyOn(console, 'warn')

    observe(count, () => commit(() => setDouble(count() * 2)))
    commit(() => setCount(2))

    expect(double()).toBe(4)
    expect(warn).not.toHaveBeenCalled()
  })

  test('trackDeep subscribes to nested values', () => {
    const [store, setStore] = createStore({ nested: { list: [{ name: 'a' }] } })
    const spy = vi.fn()

    observe(() => trackDeep(store), spy)
    setStore((draft) => {
      draft.nested.list[0]!.name = 'b'
    })
    flush()

    expect(spy).toHaveBeenCalledOnce()
  })
})
