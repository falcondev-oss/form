import { createStore, snapshot, untrack } from '@solidjs/signals'
import { parsePath } from 'dot-prop'
import { isArray, isPlainObject } from 'remeda'
import { commit } from './reactive'
import { clonePlain, pathSegmentsToPathString } from './util'

export type PathSegment = string | number

/** An array mutation, normalized so the field cache can mirror it item by item. */
export type ArrayChange =
  | { type: 'splice'; start: number; deleteCount: number; insertCount: number }
  | { type: 'permute'; order: number[] }
  | { type: 'fill'; start: number; end: number }
  | { type: 'replace' }

export type FormStoreHooks = {
  /** Before a value at `path` is replaced through the data proxy. */
  beforeReplace: (path: string) => void
  /** Before an array at `path` is mutated through the data proxy. */
  beforeArrayChange: (path: string, change: ArrayChange) => void
  /** Inside the write's batch, so state derived from it updates together. */
  onWrite: (path: string) => void
  /** After the write is visible. */
  afterWrite: (path: string) => void
}

const ARRAY_MUTATIONS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
])

const segmentCache = new Map<string, PathSegment[]>()
export function toSegments(path: string): PathSegment[] {
  if (path === '') return []
  let segments = segmentCache.get(path)
  if (!segments) {
    segments = parsePath(path) as PathSegment[]
    segmentCache.set(path, segments)
  }
  return segments
}

export function getIn(value: unknown, segments: readonly PathSegment[]): unknown {
  let current = value
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<PropertyKey, unknown>)[segment]
  }
  return current
}

function relativeIndex(value: unknown, length: number) {
  const index = Math.trunc(Number(value)) || 0
  return index < 0 ? Math.max(length + index, 0) : Math.min(index, length)
}

// Array.prototype.sort's default order, applied to values instead of indices
function defaultCompare(a: unknown, b: unknown) {
  if (a === undefined) return b === undefined ? 0 : 1
  if (b === undefined) return -1
  // oxlint-disable-next-line typescript/no-base-to-string -- matches the native default sort
  const [sa, sb] = [String(a), String(b)]
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

export type FormStore = ReturnType<typeof createFormStore>

/**
 * Form data as a Solid store, exposed through writable proxies: reads are
 * tracked store reads, writes become store setter calls. Proxies are
 * path-based (a write needs the path into the setter's draft) and cached per
 * store node, so a replaced object gets a new proxy identity.
 */
export function createFormStore(initial: object, hooks: FormStoreHooks) {
  const [state, setState] = createStore<Record<PropertyKey, unknown>>(
    initial as Record<PropertyKey, unknown>,
  )
  const proxyCache = new WeakMap<object, Map<string, object>>()
  const proxySegments = new WeakMap<object, PathSegment[]>()

  const read = (segments: readonly PathSegment[]) => getIn(state, segments)
  const peek = (segments: readonly PathSegment[]) => untrack(() => read(segments))

  function wrap(segments: PathSegment[], value: unknown): unknown {
    if (!isArray(value) && !isPlainObject(value)) return value

    const path = pathSegmentsToPathString(segments)
    let byPath = proxyCache.get(value)
    if (!byPath) proxyCache.set(value, (byPath = new Map()))
    let proxy = byPath.get(path)
    if (!proxy) {
      proxy = createDataProxy(segments, isArray(value))
      proxySegments.set(proxy, segments)
      byPath.set(path, proxy)
    }
    return proxy
  }

  // detaches a value from proxies and the caller's own objects before it enters the store
  function toRaw(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value
    const segments = proxySegments.get(value)
    if (segments) return clonePlain(untrack(() => snapshot(read(segments))))
    if (isArray(value)) return value.map(toRaw)
    if (isPlainObject(value))
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toRaw(v)]))
    return value
  }

  function setIn(segments: readonly PathSegment[], value: unknown) {
    setState((draft) => {
      if (segments.length === 0) return (value ?? {}) as Record<PropertyKey, unknown>

      let node = draft as Record<PropertyKey, unknown>
      for (const [i, segment] of segments.slice(0, -1).entries()) {
        if (node[segment] === null || typeof node[segment] !== 'object')
          node[segment] = typeof segments[i + 1] === 'number' ? [] : {}
        node = node[segment] as Record<PropertyKey, unknown>
      }
      node[segments.at(-1)!] = value
    })
  }

  function write(segments: PathSegment[], value: unknown) {
    const path = pathSegmentsToPathString(segments)
    hooks.beforeReplace(path)
    const raw = toRaw(value)
    commit(() => {
      setIn(segments, raw)
      hooks.onWrite(path)
    })
    hooks.afterWrite(path)
  }

  function remove(segments: PathSegment[]) {
    const path = pathSegmentsToPathString(segments)
    commit(() => {
      setState((draft) => {
        const parent = getIn(draft, segments.slice(0, -1))
        if (parent && typeof parent === 'object')
          delete (parent as Record<PropertyKey, unknown>)[segments.at(-1)!]
      })
      hooks.onWrite(path)
    })
    hooks.afterWrite(path)
  }

  function mutateArray(segments: PathSegment[], method: string, args: unknown[]): unknown {
    const path = pathSegmentsToPathString(segments)
    const current = peek(segments)
    if (!isArray(current)) throw new TypeError(`useForm: ${path} is not an array`)
    const { length } = current

    const splice = (start: number, deleteCount: number, insertCount: number) =>
      ({ type: 'splice', start, deleteCount, insertCount }) as const

    let change: ArrayChange
    let rawArgs = args
    switch (method) {
      case 'push':
        change = splice(length, 0, args.length)
        rawArgs = args.map(toRaw)
        break
      case 'unshift':
        change = splice(0, 0, args.length)
        rawArgs = args.map(toRaw)
        break
      case 'pop':
        change = splice(Math.max(length - 1, 0), length > 0 ? 1 : 0, 0)
        break
      case 'shift':
        change = splice(0, length > 0 ? 1 : 0, 0)
        break
      case 'splice': {
        const start = args.length === 0 ? length : relativeIndex(args[0], length)
        const deleteCount =
          args.length < 2
            ? length - start
            : Math.min(Math.max(Math.trunc(Number(args[1])) || 0, 0), length - start)
        change = splice(start, deleteCount, Math.max(args.length - 2, 0))
        rawArgs = args.map((arg, i) => (i < 2 ? arg : toRaw(arg)))
        break
      }
      case 'fill':
        change = {
          type: 'fill',
          start: relativeIndex(args[1] ?? 0, length),
          end: args[2] === undefined ? length : relativeIndex(args[2], length),
        }
        rawArgs = [toRaw(args[0]), ...args.slice(1)]
        break
      case 'sort':
      case 'reverse': {
        const items = clonePlain(untrack(() => snapshot(current)))
        const order = items.map((_, i) => i)
        if (method === 'reverse') order.reverse()
        else {
          const compare =
            (args[0] as ((a: unknown, b: unknown) => number) | undefined) ?? defaultCompare
          order.sort((a, b) => compare(items[a], items[b]))
        }

        hooks.beforeArrayChange(path, { type: 'permute', order })
        commit(() => {
          setIn(
            segments,
            order.map((i) => items[i]),
          )
          hooks.onWrite(path)
        })
        hooks.afterWrite(path)
        return wrap(segments, peek(segments))
      }
      default:
        change = { type: 'replace' }
    }

    hooks.beforeArrayChange(path, change)
    let result: unknown
    commit(() => {
      setState((draft) => {
        const array = getIn(draft, segments) as unknown as Record<
          string,
          (...a: unknown[]) => unknown
        >
        result = clonePlain(array[method]!(...rawArgs))
      })
      hooks.onWrite(path)
    })
    hooks.afterWrite(path)

    return method === 'fill' || method === 'copyWithin' ? wrap(segments, peek(segments)) : result
  }

  function createDataProxy(segments: PathSegment[], isArrayTarget: boolean): object {
    const childSegments = (key: string): PathSegment[] => [
      ...segments,
      isArrayTarget && /^\d+$/.test(key) ? Number(key) : key,
    ]
    const readNode = () => {
      const node = read(segments)
      return node !== null && typeof node === 'object'
        ? (node as Record<PropertyKey, unknown>)
        : undefined
    }

    return new Proxy(isArrayTarget ? [] : {}, {
      get(_target, key) {
        const node = readNode()
        if (!node) return undefined

        if (isArray(node)) {
          if (key === Symbol.iterator) return Array.prototype[Symbol.iterator]
          if (typeof key === 'string' && ARRAY_MUTATIONS.has(key))
            return (...args: unknown[]) => mutateArray(segments, key, args)
          // generic array methods run against this proxy, so items stay writable proxies
          if (typeof key === 'string' && key !== 'length' && !/^\d+$/.test(key)) {
            const method = (Array.prototype as unknown as Record<string, unknown>)[key]
            if (typeof method === 'function') return method
          }
        }

        if (typeof key === 'symbol') return Reflect.get(node, key)
        return wrap(childSegments(key), Reflect.get(node, key))
      },
      set(_target, key, value) {
        if (typeof key === 'symbol') return false

        const node = untrack(readNode)
        if (isArray(node) && key === 'length') {
          const newLength = Number(value)
          if (newLength < node.length) mutateArray(segments, 'splice', [newLength])
          else write(childSegments(key), newLength)
          return true
        }

        write(childSegments(key), value)
        return true
      },
      defineProperty(_target, key, descriptor) {
        if (typeof key === 'symbol' || !('value' in descriptor)) return false
        write(childSegments(key), descriptor.value)
        return true
      },
      deleteProperty(_target, key) {
        if (typeof key === 'symbol') return false
        remove(childSegments(key))
        return true
      },
      has(_target, key) {
        const node = readNode()
        return !!node && Reflect.has(node, key)
      },
      ownKeys() {
        const node = readNode()
        const keys = node ? Reflect.ownKeys(node) : []
        if (isArrayTarget && !keys.includes('length')) keys.push('length')
        return keys
      },
      getOwnPropertyDescriptor(_target, key) {
        const node = readNode()
        // proxy invariant: the array target's own `length` is non-configurable
        if (isArrayTarget && key === 'length')
          return {
            value: isArray(node) ? node.length : 0,
            writable: true,
            enumerable: false,
            configurable: false,
          }
        if (!node || typeof key === 'symbol') return undefined

        const descriptor = Reflect.getOwnPropertyDescriptor(node, key)
        if (!descriptor) return undefined
        return {
          value: wrap(childSegments(key), Reflect.get(node, key)),
          writable: true,
          enumerable: descriptor.enumerable,
          configurable: true,
        }
      },
    })
  }

  return {
    /** The store itself, for tracked plain reads. */
    state,
    /** Tracked read; objects and arrays come back as writable proxies. */
    get: (segments: PathSegment[]) => wrap(segments, read(segments)),
    read,
    /** Writes without hooks; call inside `commit()`. */
    set: (path: string, value: unknown) => setIn(toSegments(path), toRaw(value)),
    /** Replaces all data; call inside `commit()`. */
    replace: (value: object) => setIn([], toRaw(value)),
    mutateArray: (path: string, method: string, args: unknown[]) =>
      mutateArray(toSegments(path), method, args),
    /** A detached plain copy, safe to hand to validators that mutate their input. */
    snapshot: () => clonePlain(untrack(() => snapshot(state))),
  }
}
