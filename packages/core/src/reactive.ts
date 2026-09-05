import { createStore, runWithOwner } from '@solidjs/signals'

const arrayMutators = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
])

/** A writable view of a store. Every operation enters the engine's draft scope. */
export function writable<T extends object>(store: T): { -readonly [K in keyof T]: T[K] } {
  const [, set] = createStore<object>(store)
  const facades = new WeakMap<object, object>()
  const stores = new WeakMap<object, object>()
  const unwrap = (value: unknown) =>
    value !== null && typeof value === 'object' ? (stores.get(value) ?? value) : value

  function wrap<V>(value: V): V {
    if (!isReference(value)) return value
    const node = value as object
    const cached = facades.get(node)
    if (cached) return cached as V
    const proxy = new Proxy(node, {
      get(target, key) {
        const result: unknown = Reflect.get(target, key)
        if (Array.isArray(target) && typeof result === 'function') {
          if (!arrayMutators.has(String(key)))
            return (...args: unknown[]) => Reflect.apply(result, proxy, args)
          return (...args: unknown[]) => {
            let result: unknown
            set(() => {
              result = Reflect.apply(
                Reflect.get(node, key) as Function,
                proxy,
                args.map((value) => prepare(unwrap(value))),
              )
            })
            return result
          }
        }
        return wrap(result)
      },
      set(_, key, value) {
        set(() => {
          Reflect.set(node, key, prepare(unwrap(value)))
        })
        return true
      },
      deleteProperty(_, key) {
        set(() => {
          Reflect.deleteProperty(node, key)
        })
        return true
      },
    })
    facades.set(node, proxy)
    stores.set(proxy, node)
    return proxy as V
  }
  return wrap(store)
}

export { createEffect, createRoot, createSignal, createStore, flush } from '@solidjs/signals'

export function isReference(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return Array.isArray(value) || prototype === Object.prototype || prototype === null
}

const opaque = new WeakSet<object>()

/** Keep class instances opaque using the engine's shallow-store boundary. */
export function prepare<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  if (!isReference(value)) {
    if (!opaque.has(value)) {
      runWithOwner(null, () => createStore({ value }, { shallow: true }))
      opaque.add(value)
    }
  } else {
    for (const key of Object.keys(value)) prepare(Reflect.get(value, key), seen)
  }
  return value
}

/** Clone schema containers; files, blobs and class instances are opaque leaves. */
export function clone<T>(value: T, seen = new WeakMap<object, object>()): T {
  if (!isReference(value)) return prepare(value)
  const cached = seen.get(value)
  if (cached) return cached as T
  const result = (Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value))) as object
  if (Array.isArray(value)) Reflect.set(result, 'length', value.length)
  seen.set(value, result)
  for (const key of Object.keys(value))
    Reflect.set(result, key, clone(Reflect.get(value, key), seen))
  return result as T
}
