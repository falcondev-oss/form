import type { Accessor, Owner } from '@solidjs/signals'
import type { Location, Step } from './location'
import { $TARGET, createMemo, createStore, runWithOwner, snapshot, untrack } from '@solidjs/signals'
import { isArray, isPlainObject } from 'remeda'
import { clonePlain, isDeepEqual } from './util'

export type PathSegment = string | number

/**
 * The item keys of the arrays in the data, kept beside it: `list` holds an
 * array's item keys in order, `children` the keys below each item (by item
 * key) or property. A field bound to an item key follows the item when it moves.
 */
export type Keys = { list?: string[]; children?: Record<string, Keys> }

/** Plain data with its keys: the store, the source values and snapshots have this shape. */
export type Keyed = { data: Obj; keys: Keys }

/** An array item with its key and the keys below it. */
type Item = { key: string; value: unknown; keys: Keys | undefined }

export type ItemKey = string | ((item: unknown) => unknown)

export type FormStoreOptions = {
  owner: Owner
  itemKey: ItemKey | undefined
}

let keyCounter = 0
const newKey = () => `${(++keyCounter).toString(36)}${Math.random().toString(36).slice(2, 6)}`

type Obj = Record<PropertyKey, unknown>
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null
const isContainer = (value: unknown): value is object => isArray(value) || isPlainObject(value)
const isIndex = (value: unknown) => typeof value === 'string' && /^\d+$/.test(value)
const isStoreNode = (value: object) => (value as Record<symbol, unknown>)[$TARGET] !== undefined
const isEmptyKeys = (keys: Keys): boolean =>
  !keys.list && Object.values(keys.children ?? {}).every(isEmptyKeys)
const sameKind = (a: unknown, b: unknown) =>
  isContainer(a) && isContainer(b) && isArray(a) === isArray(b)

/** Whether `stored` and `plain` differ in this node alone: kind, keys, length or leaf value. */
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
    const { length } = stored
    if (!isArray(plain) || plain.length !== length) return true
    for (let i = 0; i < length; i++) {
      if (findDifference(stored[i], plain[i], false, path)) {
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
    if (!isObject(stored) || !Object.hasOwn(stored, segment)) return false
    stored = stored[segment]
    plain = (plain as Obj)[segment]
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

export type FormStore = ReturnType<typeof createFormStore>

export function createFormStore(initial: object, opts: FormStoreOptions) {
  const itemId = (item: unknown): unknown => {
    if (typeof opts.itemKey === 'function') return opts.itemKey(item)
    return isPlainObject(item) ? item[opts.itemKey ?? 'id'] : undefined
  }

  function itemsOf(value: unknown, keys: Keys | undefined): Item[] {
    if (!isArray(value) || !keys?.list) return []
    return keys.list.map((key, i) => ({ key, value: value[i], keys: keys.children?.[key] }))
  }

  /**
   * Keys for plain `value`. An array item keeps the key of the previous item it
   * matches: the same object (`identity`, from a draft), else the same item id,
   * else the same primitive value, else (no id on either side) the same position.
   */
  function toKeys(
    value: unknown,
    prevValue: unknown,
    prevKeys: Keys | undefined,
    identity?: WeakMap<object, Item>,
  ): Keys | undefined {
    const children: Record<string, Keys> = {}
    const withChildren = (keys: Keys) =>
      Object.keys(children).length > 0 ? { ...keys, children } : keys

    if (isArray(value)) {
      const matched = matchItems(itemsOf(prevValue, prevKeys), value, identity)
      const list = value.map((item, i) => {
        const key = matched[i]?.key ?? newKey()
        const below = toKeys(item, matched[i]?.value, matched[i]?.keys, identity)
        if (below) children[key] = below
        return key
      })
      return withChildren({ list })
    }
    if (isPlainObject(value)) {
      const prev = isPlainObject(prevValue) ? prevValue : undefined
      for (const [prop, v] of Object.entries(value)) {
        const below = toKeys(v, prev?.[prop], prevKeys?.children?.[prop], identity)
        if (below) children[prop] = below
      }
      return Object.keys(children).length > 0 ? withChildren({}) : undefined
    }
    return undefined
  }

  function matchItems(
    previous: Item[],
    next: readonly unknown[],
    identity?: WeakMap<object, Item>,
  ) {
    const used = new Set<string>()
    const take = (item: Item | undefined) => {
      if (!item || used.has(item.key)) return
      used.add(item.key)
      return item
    }
    const isDraftItem = (value: unknown) => isObject(value) && !!identity?.has(value)

    const matched = next.map((value) => (isObject(value) ? take(identity?.get(value)) : undefined))

    const previousIds = previous.map((item) => itemId(item.value) ?? undefined)
    const byId = new Map<unknown, Item>()
    for (const [i, item] of previous.entries()) {
      const id = previousIds[i]
      if (id !== undefined && !byId.has(id)) byId.set(id, item)
    }
    for (const [i, value] of next.entries()) {
      if (matched[i] || isDraftItem(value)) continue
      const id = itemId(value) ?? undefined
      if (id !== undefined) matched[i] = take(byId.get(id))
      else if (!isObject(value))
        matched[i] = take(previous.find((p) => !used.has(p.key) && Object.is(p.value, value)))
    }
    for (const [i, value] of next.entries()) {
      if (matched[i] || isDraftItem(value)) continue
      if ((itemId(value) ?? undefined) === undefined && previousIds[i] === undefined)
        matched[i] = take(previous[i])
    }
    return matched
  }

  /** Copy of plain `value`; `identity` records each object array item with its key. */
  function toDraft(
    value: unknown,
    keys: Keys | undefined,
    identity: WeakMap<object, Item>,
  ): unknown {
    if (isArray(value)) {
      return itemsOf(value, keys).map((item) => {
        const copy = toDraft(item.value, item.keys, identity)
        if (isObject(copy)) identity.set(copy, item)
        return copy
      })
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, toDraft(v, keys?.children?.[k], identity)]),
      )
    }
    return value
  }

  const initialData = clonePlain(initial) as Obj
  const [state, setState] = createStore<Keyed>({
    data: initialData,
    keys: toKeys(initialData, undefined, undefined) ?? {},
  })

  const keyIndexes = new WeakMap<object, Accessor<Map<string, number>> | Map<string, number>>()
  function indexOfKey(list: string[], key: string) {
    let index = keyIndexes.get(list)
    if (!index) {
      const build = () => new Map(list.map((k, i) => [k, i]))
      // one memo per stored key list: every field in the array looks its item up in O(1)
      index = isStoreNode(list) ? runWithOwner(opts.owner, () => createMemo(build)) : build()
      keyIndexes.set(list, index)
    }
    return (typeof index === 'function' ? index() : index).get(key) ?? -1
  }

  /** Current positional path, value and keys of `location` in `root`; undefined once an item in it is gone. */
  function resolveIn(root: Keyed, location: Location) {
    const segments: PathSegment[] = []
    let node: unknown = root.data
    let keys: Keys | undefined = root.keys
    for (const step of location) {
      if ('prop' in step) {
        segments.push(step.prop)
        node = isObject(node) && !isArray(node) ? node[step.prop] : undefined
        keys = keys?.children?.[step.prop]
        continue
      }
      const list: string[] | undefined = isArray(node) ? keys?.list : undefined
      const index = 'item' in step ? (list ? indexOfKey(list, step.item) : -1) : step.index
      if (index < 0) return undefined
      segments.push(index)
      node = isArray(node) ? node[index] : undefined
      const key: string | undefined = 'item' in step ? step.item : list?.[index]
      keys = key === undefined ? undefined : keys?.children?.[key]
    }
    return { segments, node, keys }
  }

  /** Positional path → location, binding each existing array item to its key. */
  function locateIn(root: Keyed, segments: readonly PathSegment[]): Step[] {
    const location: Step[] = []
    let node: unknown = root.data
    let keys: Keys | undefined = root.keys
    for (const segment of segments) {
      const atArray = isArray(node) || node === undefined || node === null
      if (atArray && (typeof segment === 'number' || isIndex(segment))) {
        const list: string[] | undefined = isArray(node) ? keys?.list : undefined
        const position = Number(segment)
        const index: number = position < 0 && list ? list.length + position : position
        const key: string | undefined = list?.[index]
        location.push(key === undefined ? { index } : { item: key })
        node = isArray(node) ? node[index] : undefined
        keys = key === undefined ? undefined : keys?.children?.[key]
      } else {
        location.push({ prop: String(segment) })
        node = isObject(node) && !isArray(node) ? node[segment] : undefined
        keys = keys?.children?.[String(segment)]
      }
    }
    return location
  }

  const resolve = (location: Location) => resolveIn(state, location)

  /**
   * Makes the draft `target` equal to `next`, moving array items by key. Items
   * and objects that stay are updated in place, so their store nodes (and what
   * readers hold of them) follow them.
   */
  function apply(target: Obj, next: Obj, keys: Keys | undefined, nextKeys: Keys | undefined) {
    if (isArray(target)) {
      const byKey = new Map<string, unknown>()
      for (const [i, key] of (keys?.list ?? []).entries()) byKey.set(key, target[i])
      const items = (next as unknown as unknown[]).map((value, i) => {
        const key = nextKeys?.list?.[i]
        const current = key === undefined ? undefined : byKey.get(key)
        if (!sameKind(current, value)) return value
        apply(current as Obj, value as Obj, keys?.children?.[key!], nextKeys?.children?.[key!])
        return current
      })
      const changed =
        items.length !== target.length || items.some((item, i) => !Object.is(item, target[i]))
      if (changed) (target as unknown as unknown[]).splice(0, target.length, ...items)
      return
    }
    for (const prop of Object.keys(target)) if (!Object.hasOwn(next, prop)) delete target[prop]
    for (const [prop, value] of Object.entries(next)) {
      const current = target[prop]
      if (sameKind(current, value))
        apply(current as Obj, value as Obj, keys?.children?.[prop], nextKeys?.children?.[prop])
      else if (!Object.is(current, value) || !Object.hasOwn(target, prop)) target[prop] = value
    }
  }

  /** Writes `keys` as the keys below `name` of `parent`, in place where they exist. */
  function setKeys(parent: Keys, name: string, keys: Keys | undefined) {
    const current = parent.children?.[name]
    if (keys && current) apply(current as Obj, keys as Obj, undefined, undefined)
    else if (keys) (parent.children ??= {})[name] = keys
    else if (current) delete parent.children![name]
  }

  /** Writes plain `value` with its `keys` at `segments`, creating containers on the way. */
  function assign(segments: readonly PathSegment[], value: unknown, keys: Keys | undefined) {
    setState((draft) => {
      if (segments.length === 0) {
        const next = (isPlainObject(value) ? value : {}) as Obj
        apply(draft.data, next, draft.keys, keys)
        apply(draft.keys as Obj, (keys ?? {}) as Obj, undefined, undefined)
        return
      }

      let parent = draft.data
      let parentKeys = draft.keys
      // a keys node missing on the way is built off the store, and only stored if it gets keys
      let detached: { parent: Keys; name: string; node: Keys } | undefined
      const finish = () => {
        if (detached && !isEmptyKeys(detached.node))
          (detached.parent.children ??= {})[detached.name] = detached.node
      }

      for (const [i, segment] of segments.entries()) {
        let name = String(segment)
        if (typeof segment === 'number') {
          const list = (parentKeys.list ??= [])
          const items = parent as unknown as unknown[]
          while (items.length <= segment) {
            items.push(undefined)
            list.push(newKey())
          }
          name = list[segment]!
        }

        const current = parent[segment]
        if (i === segments.length - 1) {
          const currentKeys = parentKeys.children?.[name]
          if (sameKind(current, value)) {
            apply(current as Obj, value as Obj, currentKeys, keys)
          } else parent[segment] = value
          setKeys(parentKeys, name, keys)
          return finish()
        }

        if (!isContainer(current)) {
          const isList = typeof segments[i + 1] === 'number'
          parent[segment] = isList ? [] : {}
          if (isList) setKeys(parentKeys, name, { list: [] })
        }
        parent = parent[segment] as Obj

        let next = parentKeys.children?.[name]
        if (!next) {
          next = {}
          if (detached) (parentKeys.children ??= {})[name] = next
          else detached = { parent: parentKeys, name, node: next }
        }
        parentKeys = next
      }
    })
  }

  function readAt(segments: readonly PathSegment[]): unknown {
    let node: unknown = state.data
    for (const segment of segments) {
      if (!isObject(node)) return undefined
      if (isArray(node)) {
        const position = Number(segment)
        node = node[position < 0 ? node.length + position : position]
      } else node = node[segment]
    }
    return node
  }

  const snapshotStored = () => clonePlain(untrack(() => snapshot(state))) as Keyed

  /** Records each object array item below stored `value` by its store node, with its key. */
  function indexItems(value: unknown, keys: Keys | undefined, identity: WeakMap<object, Item>) {
    for (const item of itemsOf(value, keys)) {
      if (isObject(item.value)) identity.set(item.value, item)
      indexItems(item.value, item.keys, identity)
    }
    if (isPlainObject(value))
      for (const [prop, v] of Object.entries(value)) indexItems(v, keys?.children?.[prop], identity)
  }

  /**
   * Writes plain data; call inside `commit()`. Items of `form.data` passed back
   * in (e.g. `[newRow, ...form.data.rows]`) keep their keys.
   */
  function write(segments: readonly PathSegment[], value: unknown) {
    const keys = untrack(() => {
      const current = resolveIn(state, locateIn(state, segments))
      const identity = new WeakMap<object, Item>()
      if (isContainer(value)) indexItems(current?.node, current?.keys, identity)
      return toKeys(value, current?.node, current?.keys, identity)
    })
    assign(
      segments,
      untrack(() => clonePlain(value)),
      keys,
    )
  }

  /**
   * Runs `recipe` on a plain copy of the data and stores the result. Items keep
   * their keys by object identity, so moved items stay bound to their fields.
   * Returns whether anything changed; call inside `commit()`.
   */
  function update(recipe: (draft: Obj) => void) {
    const before = snapshotStored()
    const identity = new WeakMap<object, Item>()
    const draft = toDraft(before.data, before.keys, identity) as Obj
    recipe(draft)
    const keys = toKeys(draft, before.data, before.keys, identity) ?? {}
    if (isDeepEqual(draft, before.data) && isDeepEqual(keys, before.keys)) return false
    assign([], clonePlain(draft), keys)
    return true
  }

  return {
    /** The data and its keys, for tracked reads. */
    state,
    /** Tracked: current positional path, value and keys of a location. */
    resolve,
    resolveIn,
    locate: (segments: readonly PathSegment[]) => locateIn(state, segments),
    locateIn,
    /** Tracked positional read; negative indices count from the end. */
    readAt,
    /** Plain data with keys matched against `previous` (by default the current data). */
    prepare: (value: unknown, previous: Keyed = state): Keyed => {
      const data = (isPlainObject(value) ? clonePlain(value) : {}) as Obj
      return { data, keys: untrack(() => toKeys(data, previous.data, previous.keys)) ?? {} }
    },
    write,
    /** Writes data with its keys at `segments` (keys kept); call inside `commit()`. */
    writeKeyed: (segments: readonly PathSegment[], value: unknown, keys: Keys | undefined) =>
      assign(segments, clonePlain(value), keys && clonePlain(keys)),
    update,
    /** A detached copy of the data and its keys. */
    snapshotStored,
  }
}
