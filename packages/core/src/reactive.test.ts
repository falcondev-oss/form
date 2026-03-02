import { reactive, watch } from '@vue/reactivity'
import { describe, expect, test, vi } from 'vitest'
import { refEffect } from './reactive'

describe('reactive', () => {
  test('refEffect reactive unwrap', () => {
    const re = refEffect(() => 1)

    expect(re.value).toBe(1)

    const refEffectWatcher = vi.fn()
    watch(re, refEffectWatcher)

    re.value = 2
    expect(re.value).toBe(2)
    expect(refEffectWatcher).toHaveBeenNthCalledWith(1, 2, 1, expect.anything())

    const wrap = reactive({ re })
    const reactiveWatcher = vi.fn()
    const reactiveWatcher2 = vi.fn()
    watch(() => wrap, reactiveWatcher, { deep: true })
    watch(() => wrap.re, reactiveWatcher2)

    wrap.re = 3
    expect(re.value).toBe(3)
    expect(refEffectWatcher).toHaveBeenNthCalledWith(2, 3, 2, expect.anything())
    expect(reactiveWatcher).toHaveBeenNthCalledWith(1, { re: 3 }, { re: 3 }, expect.anything())
    expect(reactiveWatcher2).toHaveBeenNthCalledWith(1, 3, 2, expect.anything())
  })
})
