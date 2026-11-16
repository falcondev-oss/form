import type { Owner } from '@solidjs/signals'
import type { Ref } from 'vue'
import { observe } from '@falcondev-oss/form-core/reactive'
import { runWithOwner } from '@solidjs/signals'
import { customRef, isRef } from 'vue'

const ITERATE = Symbol('iterate')
const VUE_FLAGS: Record<PropertyKey, unknown> = {
  __v_isReactive: true,
  __v_isReadonly: false,
  __v_isShallow: false,
  __v_skip: false,
  __v_raw: undefined,
}

function isBridgeable(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false
  if (Array.isArray(value)) return true
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

function isIterator(value: unknown): value is Iterator<unknown> & Iterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Iterator<unknown>).next === 'function' &&
    typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function'
  )
}

/**
 * Exposes Solid-reactive objects to Vue: every property read registers a Vue
 * dependency, backed by a Solid observer on the same read that triggers it.
 * Plain objects, arrays and null-prototype proxies (field accessors) are
 * wrapped recursively; everything else (class instances, promises) passes
 * through.
 */
export function createVueBridge(owner: Owner) {
  const proxies = new WeakMap<object, object>()
  const targets = new WeakMap<object, object>()
  const deps = new WeakMap<object, Map<PropertyKey, Ref<number>>>()
  const methods = new WeakMap<object, Map<PropertyKey, [Function, Function]>>()

  function track(target: object, key: PropertyKey, read: () => unknown) {
    let byKey = deps.get(target)
    if (!byKey) deps.set(target, (byKey = new Map()))
    let dep = byKey.get(key)
    if (!dep) {
      let version = 0
      const ref = customRef<number>((track, trigger) => ({
        get: () => {
          track()
          return version
        },
        set: (value) => {
          version = value
          trigger()
        },
      }))
      runWithOwner(owner, () =>
        observe(read, () => {
          ref.value = version + 1
        }),
      )
      byKey.set(key, ref)
      dep = ref
    }
    void dep.value
  }

  function method(target: object, key: PropertyKey, fn: Function, receiver: object) {
    let byKey = methods.get(target)
    if (!byKey) methods.set(target, (byKey = new Map()))
    const cached = byKey.get(key)
    if (cached?.[0] === fn) return cached[1]

    // array methods run against the bridge, so items read through it are tracked and wrapped
    const thisArg = Array.isArray(target) ? receiver : target
    const wrapped = (...args: unknown[]) => {
      const result = Reflect.apply(fn, thisArg, args.map(unwrap)) as unknown
      return isIterator(result) ? mapIterator(result) : toVue(result)
    }
    byKey.set(key, [fn, wrapped])
    return wrapped
  }

  function* mapIterator(iterator: Iterable<unknown>) {
    for (const item of iterator) yield toVue(item)
  }

  function unwrap<T>(value: T): T {
    return (typeof value === 'object' && value !== null && (targets.get(value) as T)) || value
  }

  function toVue<T>(value: T): T {
    if (!isBridgeable(value)) return value
    let proxy = proxies.get(value)
    if (!proxy) {
      proxy = createProxy(value)
      proxies.set(value, proxy)
      targets.set(proxy, value)
    }
    return proxy as T
  }

  function createProxy(target: object) {
    const trackKeys = () => track(target, ITERATE, () => Reflect.ownKeys(target))

    const proxy: object = new Proxy(target, {
      get(_target, key) {
        if (key in VUE_FLAGS) return VUE_FLAGS[key]
        if (key === 'constructor' || (typeof key === 'symbol' && key !== Symbol.iterator))
          return Reflect.get(target, key)

        track(target, key, () => Reflect.get(target, key))
        const value = Reflect.get(target, key) as unknown
        if (typeof value === 'function') return method(target, key, value, proxy)
        return toVue(isRef(value) ? value.value : value)
      },
      set(_target, key, value) {
        const current = Reflect.get(target, key) as unknown
        if (isRef(current) && !isRef(value)) current.value = value
        else Reflect.set(target, key, unwrap(value))
        return true
      },
      deleteProperty(_target, key) {
        return Reflect.deleteProperty(target, key)
      },
      has(_target, key) {
        if (key in VUE_FLAGS) return true
        trackKeys()
        return Reflect.has(target, key)
      },
      ownKeys() {
        trackKeys()
        return Reflect.ownKeys(target)
      },
    })
    return proxy
  }

  return { toVue }
}
