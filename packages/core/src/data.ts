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
import { isArray, isPlainObject } from 'remeda'
import { hasPendingStep, locationId } from './location'
import { commit } from './reactive'
import { clonePlain, isDeepEqual } from './util'

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

// read methods whose callback receives the array as its last argument
const CALLBACK_METHODS = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
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

/** Whether `toPlain(stored)` and `plain` differ in this node alone: kind, keys, length or leaf value. */
function nodeDiffers(stored: unknown, plain: unknown, subset: boolean): boolean {
  if (isArray(stored)) return !isArray(plain) || stored.length !== plain.length
  if (isPlainObject(stored)) {
    if (!isPlainObject(plain)) return true
    const keys = Object.keys(stored)
    if (!subset && keys.length !== Object.keys(plain).length) return true
    return keys.some((key) => !Object.hasOwn(plain, key))
  }
  return !isDeepEqual(stored, plain)
}

/** Path of the first node where stored and plain data differ, written to `path` deepest-first. */
function findDifference(
  stored: unknown,
  plain: unknown,
  subset: boolean,
  path: PathSegment[],
): boolean {
  if (isArray(stored)) {
    const entries = stored as Entry[]
    const { length } = entries
    if (!isArray(plain) || plain.length !== length) return true
    for (let i = 0; i < length; i++) {
      if (findDifference(entries[i]!.value, plain[i], false, path)) {
        path.push(i)
        return true
      }
    }
    return false
  }
  if (isPlainObject(stored)) {
    if (!isPlainObject(plain)) return true
    const keys = Object.keys(stored)
    if (!subset && keys.length !== Object.keys(plain).length) return true
    for (const key of keys) {
      if (!Object.hasOwn(plain, key)) return true
      if (findDifference(stored[key], plain[key], false, path)) {
        path.push(key)
        return true
      }
    }
    return false
  }
  return !Object.is(stored, plain) && !isDeepEqual(stored, plain)
}

/** Whether the nodes along `path` show a difference; false means unknown. */
function differsAlong(stored: unknown, plain: unknown, subset: boolean, path: PathSegment[]) {
  for (const segment of path) {
    if (nodeDiffers(stored, plain, subset)) return true
    subset = false
    if (isArray(stored)) {
      stored = (stored as Entry[])[segment as number]?.value
      plain = (plain as unknown[])[segment as number]
    } else if (isPlainObject(stored) && Object.hasOwn(stored, segment)) {
      stored = stored[segment]
      plain = (plain as Obj)[segment]
    } else return false
  }
  return nodeDiffers(stored, plain, subset)
}

/** Tracked deep inequality of stored and plain data; while the last difference lasts it reads only that path. */
export function createDiffer(stored: () => unknown, plain: () => unknown, subset = false) {
  let last: PathSegment[] = []
  return () => {
    const s = stored()
    const p = plain()
    if (last.length > 0 && differsAlong(s, p, subset, last)) return true
    const path: PathSegment[] = []
    const differs = findDifference(s, p, subset, path)
    last = path.reverse()
    return differs
  }
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
  const proxies = new WeakMap<object, object>() // stored node → its proxy
  const proxyNodes = new WeakMap<object, object>() // proxy → its stored node

  const itemId = (item: unknown): unknown => {
    if (typeof opts.itemKey === 'function') return opts.itemKey(item)
    return isPlainObject(item) ? item[opts.itemKey ?? 'id'] : undefined
  }

  /**
   * Plain data → stored form. Array items reuse the key of the `previous`
   * item they match: by item id, otherwise (no id on either side) by position.
   * Always builds new containers, so the caller's objects never enter the store.
   */
  function toStored(value: unknown, previous?: unknown): unknown {
    const proxied = isObject(value) ? proxyNodes.get(value) : undefined
    if (proxied) value = untrack(() => toPlain(proxied))

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

  /** Stored node → what users see: objects and arrays as writable proxies, one per node. */
  function present(location: Location, node: unknown): unknown {
    if (!isContainer(node)) return node
    return proxies.get(node) ?? createDataProxy(node as Obj, location)
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
    const stored = untrack(() => toStored(value, readAt(segments)))
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

  /**
   * Applies an array method to the stored entries. `expected` is the stored
   * array a data proxy is bound to: if the location holds another array by now,
   * the proxy is stale and the call changes nothing.
   */
  function mutateArray(
    location: Location,
    method: string,
    args: unknown[],
    expected?: object,
  ): unknown {
    const resolved = peek(location)
    if (expected && resolved?.node !== expected) return undefined
    if (!resolved || !isArray(resolved.node))
      throw new TypeError(`useForm: ${locationId(location)} is not an array`)
    const { segments, node } = resolved
    const before = untrack(() => toPlain(node)) as unknown[]
    const after = [...before]
    const toEntry = (item: unknown): Entry => ({
      key: newKey(),
      value: untrack(() => toStored(item)),
    })

    let result: unknown
    let changed: boolean
    let mutate: (entries: Entry[]) => void
    switch (method) {
      case 'push':
      case 'unshift': {
        result = after[method](...args)
        const added = args.map(toEntry)
        changed = added.length > 0
        mutate = (entries) => entries[method](...added)
        break
      }
      case 'pop':
      case 'shift':
        result = after[method]()
        changed = before.length > 0
        mutate = (entries) => void entries[method]()
        break
      case 'splice': {
        const removed = (after.splice as (...a: unknown[]) => unknown[])(...args)
        const added = args.slice(2).map(toEntry)
        result = removed
        changed = removed.length > 0 || added.length > 0
        mutate = (entries) =>
          void (entries.splice as (...a: unknown[]) => Entry[])(...args.slice(0, 2), ...added)
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
        changed = order.some((from, i) => from !== i)
        const entries = clonePlain(untrack(() => snapshot(node))) as Entry[]
        mutate = (draftEntries) =>
          reconcile(
            order.map((i) => entries[i]!),
            'key',
          )(draftEntries)
        break
      }
      default: {
        // fill / copyWithin: values change in place, items keep their keys
        ;(after as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args)
        const updates = untrack(() =>
          after.flatMap((value, i) =>
            isDeepEqual(value, before[i])
              ? []
              : [[i, toStored(value, (node as Entry[])[i]?.value)] as const],
          ),
        )
        changed = updates.length > 0
        mutate = (entries) => {
          for (const [i, stored] of updates) entries[i]!.value = stored
        }
      }
    }

    // like Vue's `hasChanged()`: a call that changes nothing is no edit
    if (changed)
      writeThrough(locationId(location), () =>
        setState((draft) => mutate(containerAt(draft, segments) as unknown as Entry[])),
      )
    return ['sort', 'reverse', 'fill', 'copyWithin'].includes(method)
      ? present(location, node)
      : result
  }

  /**
   * A writable view of one stored node, in the spirit of Vue's `reactive()`:
   * reads go straight to the bound node (one tracked store read each), and the
   * location (by item key) is only resolved to a path when writing. Like a plain
   * object reference, the proxy keeps showing its node after the node leaves
   * the form; writes through such a stale proxy are ignored.
   */
  function createDataProxy(node: Obj, location: Location): object {
    // a position with no item yet binds to the item that sits there now
    if (hasPendingStep(location))
      location = untrack(() => locateIn(state, resolve(location)?.segments ?? []))

    const entries = isArray(node) ? (node as unknown as Entry[]) : undefined
    const entryAt = (key: PropertyKey) =>
      entries && isIndex(key) ? entries[Number(key)] : undefined

    // the child's location is only built for a node that has no proxy yet
    const child = (value: unknown, step: () => Step) =>
      isContainer(value)
        ? (proxies.get(value) ?? createDataProxy(value as Obj, [...location, step()]))
        : value
    const item = (entry: Entry) => child(entry.value, () => ({ item: entry.key }))
    const items = () => {
      const list: unknown[] = Array.from({ length: entries!.length })
      for (const [i, entry] of entries!.entries()) list[i] = item(entry)
      return list
    }
    const childStep = (key: string): Step => {
      if (!entries) return { prop: key }
      const entry = entryAt(key)
      return entry ? { item: entry.key } : { index: Number(key) }
    }

    /** Resolves the bound location for a write; undefined when the proxy is stale. */
    function writable() {
      const resolved = peek(location)
      return resolved?.node === node ? resolved : undefined
    }

    function setChild(key: string, value: unknown) {
      if (entries && key === 'length') {
        const length = Number(value)
        const current = untrack(() => entries.length)
        if (length < current) mutateArray(location, 'splice', [length], node)
        else if (length > current)
          mutateArray(location, 'push', Array.from({ length: length - current }), node)
        return
      }

      const current = untrack(() => (entries ? entryAt(key)?.value : node[key]))
      const exists = untrack(() => (entries ? !!entryAt(key) : key in node))
      // like Vue's `hasChanged()`: assigning the current value is no edit
      if (exists && (Object.is(current, value) || proxyNodes.get(value as object) === current))
        return

      const resolved = writable()
      if (!resolved) return
      const segment = entries ? Number(key) : key
      writeThrough(locationId([...location, childStep(key)]), () =>
        write([...resolved.segments, segment], value),
      )
    }

    // the target is a plain stand-in: invariant checks against a store proxy would cost a trap per read
    const proxy = new Proxy(entries ? [] : {}, {
      get(_target, key) {
        if (!entries) {
          if (typeof key === 'symbol') return Reflect.get(node, key)
          return child(Reflect.get(node, key), () => ({ prop: key }))
        }

        if (key === 'length') return entries.length
        if (isIndex(key)) {
          const entry = entries[Number(key)]
          return entry && item(entry)
        }
        if (typeof key === 'string' && ARRAY_MUTATIONS.has(key))
          return (...args: unknown[]) => mutateArray(location, key, args, node)

        // read methods run on a plain list of the items, like Vue's array instrumentation
        const method = (Array.prototype as unknown as Record<PropertyKey, unknown>)[key]
        if (typeof method !== 'function') return undefined
        const hasCallback = typeof key === 'string' && CALLBACK_METHODS.has(key)
        return function (this: unknown, ...args: unknown[]) {
          // another receiver (e.g. the Vue bridge) reads item by item through itself, to track each read
          if (this !== proxy && isObject(this)) return method.apply(this, args) as unknown

          if (hasCallback) {
            const callback = args[0] as (...a: unknown[]) => unknown
            args[0] = function (this: unknown, ...callbackArgs: unknown[]) {
              // the array argument is the proxy, as with a plain array
              callbackArgs[callbackArgs.length - 1] = proxy
              return callback.apply(this, callbackArgs)
            }
          }
          return method.apply(items(), args) as unknown
        }
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
        const exists = untrack(() =>
          entries ? entryAt(key)?.value !== undefined : Object.hasOwn(node, key),
        )
        const resolved = exists ? writable() : undefined
        if (!resolved) return true

        writeThrough(locationId([...location, childStep(key)]), () =>
          setState((draft) => {
            const container = containerAt(draft, resolved.segments)
            // like `delete array[i]`: the slot stays, its value goes
            if (entries) {
              const entry = (container as unknown as Entry[])[Number(key)]
              if (entry) entry.value = undefined
            } else delete container[key]
          }),
        )
        return true
      },
      has(_target, key) {
        if (entries) return key === 'length' || !!entryAt(key) || key in Array.prototype
        return Reflect.has(node, key)
      },
      ownKeys() {
        if (entries) return [...entries.keys()].map(String).concat('length')
        return Reflect.ownKeys(node)
      },
      getOwnPropertyDescriptor(_target, key) {
        // proxy invariant: the array target's own `length` is non-configurable
        if (entries && key === 'length')
          return { value: entries.length, writable: true, enumerable: false, configurable: false }
        if (typeof key === 'symbol') return undefined

        if (entries) {
          const entry = entryAt(key)
          if (!entry) return undefined
          return { value: item(entry), writable: true, enumerable: true, configurable: true }
        }

        const descriptor = Reflect.getOwnPropertyDescriptor(node, key)
        if (!descriptor) return undefined
        return {
          value: child(Reflect.get(node, key), () => ({ prop: key })),
          writable: true,
          enumerable: descriptor.enumerable,
          configurable: true,
        }
      },
    })

    proxies.set(node, proxy)
    proxyNodes.set(proxy, node)
    return proxy
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
    prepare: (value: unknown) => untrack(() => toStored(value, state)),
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
