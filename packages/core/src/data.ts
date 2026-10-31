import type { Accessor, Owner } from '@solidjs/signals'
import type { Location, Step } from './location'
import {
  $TARGET,
  createMemo,
  createStore,
  reconcile,
  runWithOwner,
  snapshot,
  untrack,
} from '@solidjs/signals'
import { isArray, isDeepEqual, isPlainObject } from 'remeda'
import { locationId } from './location'
import { commit } from './reactive'
import { clonePlain } from './util'

export type PathSegment = string | number

/**
 * How arrays are stored: each item carries a key, so item identity survives
 * moves and lives in the store itself. The data proxy hides the entries.
 */
export type Entry = { key: string; value: unknown }

export type ItemKey = string | ((item: unknown) => unknown)

export type FormStoreOptions = {
  owner: Owner
  itemKey: ItemKey | undefined
  /** Inside the write's batch, so state derived from it updates together. */
  onWrite: (id: string) => void
  /** After the write is visible. */
  afterWrite: (id: string) => void
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

let keyCounter = 0
const newKey = () => `${(++keyCounter).toString(36)}${Math.random().toString(36).slice(2, 6)}`

type Obj = Record<PropertyKey, unknown>
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null
const isContainer = (value: unknown): value is object => isArray(value) || isPlainObject(value)
const isIndex = (value: unknown) => typeof value === 'string' && /^\d+$/.test(value)
const isStoreNode = (value: object) => (value as Record<symbol, unknown>)[$TARGET] !== undefined

/** Stored form → plain data. Reads through store proxies are tracked. */
export function toPlain(value: unknown): unknown {
  if (isArray(value)) return value.map((entry) => toPlain((entry as Entry).value))
  if (isPlainObject(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlain(v)]))
  return value
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

export function createFormStore(initial: object, opts: FormStoreOptions) {
  const itemId = (item: unknown): unknown => {
    if (typeof opts.itemKey === 'function') return opts.itemKey(item)
    return isPlainObject(item) ? item[opts.itemKey ?? 'id'] : undefined
  }

  /**
   * Plain data → stored form. Array items reuse the key of the `previous`
   * item they match: by item id, otherwise (no id on either side) by position.
   */
  function toStored(value: unknown, previous?: unknown): unknown {
    if (isArray(value)) {
      const matched = matchEntries(isArray(previous) ? (previous as Entry[]) : [], value)
      return value.map((item, i) => ({
        key: matched[i]?.key ?? newKey(),
        value: toStored(item, matched[i]?.value),
      }))
    }
    if (isPlainObject(value)) {
      const prev = isPlainObject(previous) ? previous : undefined
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toStored(v, prev?.[k])]))
    }
    return value
  }

  function matchEntries(previous: Entry[], next: readonly unknown[]) {
    const previousIds = previous.map((entry) => itemId(toPlain(entry.value)) ?? undefined)
    const byId = new Map<unknown, Entry>()
    for (const [i, entry] of previous.entries()) {
      const id = previousIds[i]
      if (id !== undefined && !byId.has(id)) byId.set(id, entry)
    }

    const used = new Set<Entry>()
    return next.map((item, i): Entry | undefined => {
      const id = itemId(item) ?? undefined
      const entry =
        id === undefined ? (previousIds[i] === undefined ? previous[i] : undefined) : byId.get(id)
      if (!entry || used.has(entry)) return undefined
      used.add(entry)
      return entry
    })
  }

  const [state, setState] = createStore<Obj>(toStored(initial) as Obj)

  const keyIndexes = new WeakMap<object, Accessor<Map<string, number>> | Map<string, number>>()
  function indexOfKey(entries: Entry[], key: string) {
    let index = keyIndexes.get(entries)
    if (!index) {
      const build = () => new Map(entries.map((entry, i) => [entry.key, i]))
      // one memo per stored array: every field in it looks its item up in O(1)
      index = isStoreNode(entries) ? runWithOwner(opts.owner, () => createMemo(build)) : build()
      keyIndexes.set(entries, index)
    }
    return (typeof index === 'function' ? index() : index).get(key) ?? -1
  }

  /** Current positional path and value of `location` in `root`; undefined once an item in it is gone. */
  function resolveIn(root: unknown, location: Location) {
    const segments: PathSegment[] = []
    let node = root
    for (const step of location) {
      if ('prop' in step) {
        segments.push(step.prop)
        node = isObject(node) && !isArray(node) ? node[step.prop] : undefined
        continue
      }
      const entries = isArray(node) ? (node as Entry[]) : undefined
      const index = 'item' in step ? (entries ? indexOfKey(entries, step.item) : -1) : step.index
      if (index < 0) return undefined
      segments.push(index)
      node = entries?.[index]?.value
    }
    return { segments, node }
  }

  /** Positional path → location, binding each existing array item to its key. */
  function locateIn(root: unknown, segments: readonly PathSegment[]): Step[] {
    const location: Step[] = []
    let node = root
    for (const segment of segments) {
      const atArray = isArray(node) || node === undefined || node === null
      if (atArray && (typeof segment === 'number' || isIndex(segment))) {
        const entries = isArray(node) ? (node as Entry[]) : undefined
        const position = Number(segment)
        const index = position < 0 && entries ? entries.length + position : position
        const entry = entries?.[index]
        location.push(entry ? { item: entry.key } : { index })
        node = entry?.value
      } else {
        location.push({ prop: String(segment) })
        node = isObject(node) && !isArray(node) ? node[segment] : undefined
      }
    }
    return location
  }

  const resolve = (location: Location) => resolveIn(state, location)
  const peek = (location: Location) => untrack(() => resolve(location))

  const proxyCache = new WeakMap<object, Map<string, object>>()
  const proxyLocations = new WeakMap<object, Location>()

  /** Stored node → what users see: objects and arrays as writable proxies bound to `location`. */
  function present(location: Location, node: unknown): unknown {
    if (!isContainer(node)) return node

    const id = locationId(location)
    let byId = proxyCache.get(node)
    if (!byId) proxyCache.set(node, (byId = new Map()))
    let proxy = byId.get(id)
    if (!proxy) {
      proxy = createDataProxy(location, isArray(node))
      proxyLocations.set(proxy, location)
      byId.set(id, proxy)
    }
    return proxy
  }

  // detaches a value from proxies and the caller's own objects before it enters the store
  function toRaw(value: unknown): unknown {
    if (!isObject(value)) return value
    const location = proxyLocations.get(value)
    if (location) return untrack(() => toPlain(resolve(location)?.node))
    if (isArray(value)) return value.map(toRaw)
    if (isPlainObject(value))
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toRaw(v)]))
    return value
  }

  /** The container at `segments`, created on the way; `next` is the segment that will be read from it. */
  function containerAt(draft: Obj, segments: readonly PathSegment[], next?: PathSegment): Obj {
    let node = draft
    for (const [i, segment] of segments.entries()) {
      const makeNext = () => (typeof (segments[i + 1] ?? next) === 'number' ? [] : {})
      if (typeof segment === 'number') {
        const entries = node as unknown as Entry[]
        while (entries.length <= segment) entries.push({ key: newKey(), value: undefined })
        const entry = entries[segment]!
        if (!isContainer(entry.value)) entry.value = makeNext()
        node = entry.value as Obj
      } else {
        if (!isContainer(node[segment])) node[segment] = makeNext()
        node = node[segment] as Obj
      }
    }
    return node
  }

  /** Writes a stored value; reconcile by key keeps unchanged parts and item keys untouched. */
  function assignStored(segments: readonly PathSegment[], stored: unknown) {
    if (segments.length === 0) {
      setState(reconcile((isPlainObject(stored) ? stored : {}) as Obj, 'key'))
      return
    }

    setState((draft) => {
      const last = segments.at(-1)!
      let parent = containerAt(draft, segments.slice(0, -1), last)
      let prop: PropertyKey = last
      if (typeof last === 'number') {
        const entries = parent as unknown as Entry[]
        while (entries.length <= last) entries.push({ key: newKey(), value: undefined })
        parent = entries[last] as unknown as Obj
        prop = 'value'
      }

      const current = parent[prop]
      if (isContainer(current) && isContainer(stored) && isArray(current) === isArray(stored))
        reconcile(stored, 'key')(current)
      else parent[prop] = stored
    })
  }

  /** Writes plain data; call inside `commit()`. */
  function write(segments: readonly PathSegment[], value: unknown) {
    const stored = untrack(() => toStored(toRaw(value), readAt(segments)))
    assignStored(segments, stored)
  }

  function readAt(segments: readonly PathSegment[]): unknown {
    let node: unknown = state
    for (const segment of segments) {
      if (!isObject(node)) return undefined
      if (isArray(node)) {
        const entries = node as unknown as Entry[]
        const position = Number(segment)
        node = entries[position < 0 ? entries.length + position : position]?.value
      } else node = node[segment]
    }
    return node
  }

  function writeThrough(id: string, apply: () => void) {
    commit(() => {
      apply()
      opts.onWrite(id)
    })
    opts.afterWrite(id)
  }

  function mutateArray(location: Location, method: string, args: unknown[]): unknown {
    const resolved = peek(location)
    if (!resolved || !isArray(resolved.node))
      throw new TypeError(`useForm: ${locationId(location)} is not an array`)
    const { segments } = resolved
    const before = untrack(() => toPlain(resolved.node)) as unknown[]
    const after = [...before]
    const toEntry = (item: unknown): Entry => ({ key: newKey(), value: toStored(item) })

    let result: unknown
    let mutate: (entries: Entry[]) => void
    switch (method) {
      case 'push':
      case 'unshift': {
        const items = args.map(toRaw)
        result = after[method](...items)
        mutate = (entries) => entries[method](...items.map(toEntry))
        break
      }
      case 'pop':
      case 'shift':
        result = after[method]()
        mutate = (entries) => void entries[method]()
        break
      case 'splice': {
        const rawArgs = args.map((arg, i) => (i < 2 ? arg : toRaw(arg)))
        result = (after.splice as (...a: unknown[]) => unknown[])(...rawArgs)
        mutate = (entries) =>
          void (entries.splice as (...a: unknown[]) => Entry[])(
            ...rawArgs.map((arg, i) => (i < 2 ? arg : toEntry(arg))),
          )
        break
      }
      case 'sort':
      case 'reverse': {
        const order = before.map((_, i) => i)
        if (method === 'reverse') order.reverse()
        else {
          const compare =
            (args[0] as ((a: unknown, b: unknown) => number) | undefined) ?? defaultCompare
          order.sort((a, b) => compare(before[a], before[b]))
        }
        const entries = clonePlain(untrack(() => snapshot(resolved.node))) as Entry[]
        mutate = (draftEntries) =>
          reconcile(
            order.map((i) => entries[i]!),
            'key',
          )(draftEntries)
        break
      }
      default: {
        // fill / copyWithin: values change in place, items keep their keys
        ;(after as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(
          ...args.map(toRaw),
        )
        mutate = (entries) => {
          for (const [i, value] of after.entries())
            if (!isDeepEqual(value, before[i]))
              entries[i]!.value = toStored(value, entries[i]!.value)
        }
      }
    }

    writeThrough(locationId(location), () =>
      setState((draft) => mutate(containerAt(draft, segments) as unknown as Entry[])),
    )
    return ['sort', 'reverse', 'fill', 'copyWithin'].includes(method)
      ? present(location, peek(location)?.node)
      : result
  }

  function createDataProxy(location: Location, isArrayTarget: boolean): object {
    const readNode = () => {
      const node = resolve(location)?.node
      return isObject(node) ? node : undefined
    }
    const entryAt = (node: Obj, key: PropertyKey) =>
      isArray(node) && isIndex(key) ? (node as unknown as Entry[])[Number(key)] : undefined
    const childStep = (node: Obj | undefined, key: string): Step => {
      if (!isArray(node)) return { prop: key }
      const entry = entryAt(node, key)
      return entry ? { item: entry.key } : { index: Number(key) }
    }

    function setChild(key: string, value: unknown) {
      const node = untrack(readNode)
      const resolved = peek(location)
      if (!resolved) return
      if (isArray(node) && key === 'length') {
        const length = Number(value)
        if (length < node.length) mutateArray(location, 'splice', [length])
        else mutateArray(location, 'push', Array.from({ length: length - node.length }))
        return
      }
      const step = childStep(node, key)
      const segment = isArray(node) ? Number(key) : key
      writeThrough(locationId([...location, step]), () =>
        write([...resolved.segments, segment], value),
      )
    }

    return new Proxy(isArrayTarget ? [] : {}, {
      get(_target, key) {
        const node = readNode()
        if (!node) return undefined

        if (isArray(node)) {
          if (key === Symbol.iterator) return Array.prototype[Symbol.iterator]
          if (typeof key === 'symbol') return undefined
          if (key === 'length') return node.length
          if (ARRAY_MUTATIONS.has(key))
            return (...args: unknown[]) => mutateArray(location, key, args)
          const entry = entryAt(node, key)
          if (entry) return present([...location, { item: entry.key }], entry.value)
          if (isIndex(key)) return undefined
          // generic array methods run against this proxy, so items stay writable proxies
          const method = (Array.prototype as unknown as Obj)[key]
          return typeof method === 'function' ? method : undefined
        }

        if (typeof key === 'symbol') return Reflect.get(node, key)
        return present([...location, { prop: key }], Reflect.get(node, key))
      },
      set(_target, key, value) {
        if (typeof key === 'symbol') return false
        setChild(key, value)
        return true
      },
      defineProperty(_target, key, descriptor) {
        if (typeof key === 'symbol' || !('value' in descriptor)) return false
        setChild(key, descriptor.value)
        return true
      },
      deleteProperty(_target, key) {
        if (typeof key === 'symbol') return false
        const node = untrack(readNode)
        const resolved = peek(location)
        if (!node || !resolved) return true

        writeThrough(locationId([...location, childStep(node, key)]), () =>
          setState((draft) => {
            const container = containerAt(draft, resolved.segments)
            // like `delete array[i]`: the slot stays, its value goes
            if (isArray(node)) {
              const entry = (container as unknown as Entry[])[Number(key)]
              if (entry) entry.value = undefined
            } else delete container[key]
          }),
        )
        return true
      },
      has(_target, key) {
        const node = readNode()
        if (!node) return false
        if (isArray(node)) return key === 'length' || !!entryAt(node, key) || key in Array.prototype
        return Reflect.has(node, key)
      },
      ownKeys() {
        const node = readNode()
        if (!node) return isArrayTarget ? ['length'] : []
        if (isArray(node)) return [...node.keys()].map(String).concat('length')
        return Reflect.ownKeys(node)
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

        if (isArray(node)) {
          const entry = entryAt(node, key)
          if (!entry) return undefined
          return {
            value: present([...location, { item: entry.key }], entry.value),
            writable: true,
            enumerable: true,
            configurable: true,
          }
        }

        const descriptor = Reflect.getOwnPropertyDescriptor(node, key)
        if (!descriptor) return undefined
        return {
          value: present([...location, { prop: key }], Reflect.get(node, key)),
          writable: true,
          enumerable: descriptor.enumerable,
          configurable: true,
        }
      },
    })
  }

  return {
    /** The stored tree (arrays as entries), for tracked reads. */
    state,
    /** Tracked: current positional path and stored value of a location. */
    resolve,
    resolveIn,
    locate: (segments: readonly PathSegment[]) => locateIn(state, segments),
    locateIn,
    /** Tracked positional read; negative indices count from the end. */
    readAt,
    present,
    root: () => present([], state),
    /** Plain data → stored form, matching items against the current data. */
    prepare: (value: unknown) => untrack(() => toStored(toRaw(value), state)),
    /** Writes plain data; call inside `commit()`. */
    write,
    /** Writes an already stored value (keys kept); call inside `commit()`. */
    writeStored: (segments: readonly PathSegment[], stored: unknown) =>
      assignStored(segments, clonePlain(stored)),
    mutateArray,
    /** A detached copy of the stored tree. */
    snapshotStored: () => clonePlain(untrack(() => snapshot(state))) as Obj,
  }
}
