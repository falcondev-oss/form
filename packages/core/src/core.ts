import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { FormFieldBag } from './field'
import type {
  BuildFormFieldAccessors,
  FormData,
  FormFieldAccessorOptions,
  FormHandle,
  FormHookDefinitions,
  FormHooks,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from './types'
import {
  createEffect,
  createRoot,
  createSignal,
  createStore,
  flush,
  isWrappable,
  reconcile,
  untrack,
} from '@solidjs/signals'
import { getProperty, setProperty } from 'dot-prop'
import { createHooks } from 'hookable'
import { klona } from 'klona/full'
import { hasAtLeast, hasSubObject } from 'remeda'
import { FormField } from './field'
import { toJsonSchema } from './json-schema'
import { extend } from './types'
import { debugLog, escapePathSegment, issuePathKeys, parsePath } from './util'

function clone<const T>(value: T): T {
  return klona(value)
}

export function resolveMaybeGetter<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value
}

/**
 * A link in the chain from the store root to a node. Array links remember the
 * element proxy they were created for, so writes re-resolve the element's
 * current index after reorders (identity-safe writes).
 */
type Link = { parent: object; key: string | number; element?: object }

/** Field cache entry for one store node (keyed by engine-maintained object identity). */
type NodeRecord = {
  facade: object
  self?: FormField<unknown, any>
  children: Map<string | number, FormField<unknown, any>>
}

type FacadeMeta = { target: object; links: Link[] }

function isReferenceValue(value: unknown): boolean {
  return value !== null && value !== undefined && isWrappable(value)
}

/** Global post-flush listeners (used by framework adapters for per-field bindings). */
const globalListeners = new Set<() => void>()

export function subscribeFormUpdates(listener: () => void): () => void {
  globalListeners.add(listener)
  return () => globalListeners.delete(listener)
}

export function useFormCore<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
  const Data extends FormData<Schema> = FormData<Schema>,
>(formOpts: FormOptions<Schema, SourceValues>) {
  const hooks = createHooks<FormHookDefinitions<Schema>>()
  if (formOpts.hooks) hooks.addHooks(formOpts.hooks)

  const standardSchema = formOpts.schema['~standard']
  const jsonSchema = toJsonSchema(formOpts.schema)

  const [version, setVersion] = createSignal(0)
  const [pristineVersion, setPristineVersion] = createSignal(0)
  // synchronous mirrors: signal writes are batched, dirty checks must not be
  let versionValue = 0
  let pristineValue = 0

  const [isPendingSignal, setIsPendingSignal] = createSignal(false)
  const [isSubmittingSignal, setIsSubmittingSignal] = createSignal(false)
  const [isValidatingSignal, setIsValidatingSignal] = createSignal(false)
  let isPendingValue = false
  let isSubmittingValue = false
  let isValidatingValue = false

  function setIsPending(value: boolean) {
    isPendingValue = value
    setIsPendingSignal(value)
  }
  function setIsSubmitting(value: boolean) {
    isSubmittingValue = value
    setIsSubmittingSignal(value)
  }
  function setIsValidating(value: boolean) {
    isValidatingValue = value
    setIsValidatingSignal(value)
  }

  const [formError, setFormError] = createSignal<StandardSchemaV1.FailureResult | undefined>(
    undefined,
  )

  function resolveSource(): Data | undefined {
    return resolveMaybeGetter(formOpts.sourceValues as Data | (() => Data))
  }

  const [sourceSnapshot, setSourceSnapshot] = createSignal<Data>(
    clone(resolveSource() ?? ({} as Data)) as any,
  )

  const isLoading = () => isPendingValue || isValidatingValue || isSubmittingValue
  const isDisabled = () => isLoading() || (resolveMaybeGetter(formOpts.disabled ?? false) ?? false)
  const isDirty = () => versionValue !== pristineValue

  function bump() {
    versionValue++
    setVersion(versionValue)
  }

  /** Facades must never be stored back into the store — they wrap its own nodes. */
  function unwrapValue<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
      const meta = facadeMeta.get(value)
      if (meta) return meta.target as T
    }
    return value
  }

  function markPristine() {
    pristineValue = versionValue
    setPristineVersion(pristineValue)
  }

  let queueReset = false

  // --- reactive engine ------------------------------------------------
  // One stable node per raw object: the store keeps proxy identity across
  // array mutations, so fields cached on a node travel with their datum and
  // no cache sync exists.

  const listeners = new Set<() => void>()
  const facadesByTarget = new WeakMap<object, object>()
  const facadeMeta = new WeakMap<object, FacadeMeta>()
  const nodes = new WeakMap<object, NodeRecord>()
  const deleters = new Map<string, () => void>()
  // fields whose identity chain is broken (nullable intermediates) keyed by path
  const pathFields = new Map<string, FormField<unknown, any>>()

  function refreshKey(link: Link): string | number {
    if (typeof link.key !== 'number' || !link.element) return link.key
    const index = untrack(() => (link.parent as unknown[]).indexOf(link.element))
    return index >= 0 ? index : link.key
  }

  function resolveChain(root: any, links: Link[]): any {
    let current = root
    for (const link of links) {
      current = current[refreshKey(link)]
      if (current === undefined || current === null) return current
    }
    return current
  }

  function notify() {
    for (const listener of listeners) listener()
    for (const listener of globalListeners) listener()
  }

  /** Routes a mutation on the node at `links` through the store setter. */
  function blockedWhilePending(): boolean {
    if (!isPendingValue) return false
    console.warn('useForm:', 'Skipped write while form is pending')
    return true
  }

  function mutate(links: Link[], fn: (node: any) => void) {
    if (blockedWhilePending()) return
    bump()
    setStore((root) => {
      const node = resolveChain(root, links)
      if (node !== undefined && node !== null) fn(node)
    })
  }

  /** Sets the value at the end of `links` (the last link may re-resolve by identity). */
  function mutateAt(links: Link[], value: unknown) {
    const unwrapped = unwrapValue(value)
    if (links.length === 0) {
      bump()
      setStore(() => clone(unwrapped) as Data)
      return
    }
    mutate(links.slice(0, -1), (parent) => {
      parent[refreshKey(links[links.length - 1]!)] = unwrapped
    })
  }

  function facadeFor(target: object, links: Link[]): object {
    const existing = facadesByTarget.get(target)
    if (existing) return existing

    const facade = new Proxy(target, {
      get(_target, prop, receiver) {
        if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)

        const value = (target as any)[prop]
        if (typeof value === 'function') {
          // array/object method: route the mutation through the store setter
          return (...args: unknown[]) => {
            mutate(links, (node) => {
              node[prop](...args.map(unwrapValue))
            })
          }
        }
        if (isReferenceValue(value)) {
          return facadeFor(value, [...links, { parent: target, key: prop, element: value }])
        }
        return value
      },
      set(_target, prop, value) {
        mutate(links, (node) => {
          node[prop] = unwrapValue(value)
        })
        return true
      },
      deleteProperty(_target, prop) {
        mutate(links, (node) => {
          delete node[prop]
        })
        return true
      },
    })

    facadesByTarget.set(target, facade)
    facadeMeta.set(facade, { target, links })
    return facade
  }

  function ensureRecord(facade: object): NodeRecord {
    let record = nodes.get(facade)
    if (!record) {
      record = { facade, children: new Map() }
      nodes.set(facade, record)
    }
    return record
  }

  const [store, setStore] = createRoot(() => {
    const [store, setStore] = createStore<Data>(clone(resolveSource() ?? ({} as Data)) as any)
    let initial = true

    // observe the whole data tree: notify subscribers + schedule validation
    createEffect(
      () => JSON.stringify(store),
      () => {
        if (initial) {
          initial = false
          return
        }
        notify()
        void validateForm()
      },
    )

    // non-data state (errors, loading flags, dirty transitions) also drives adapters
    createEffect(
      () => {
        const changeToken =
          version() +
          pristineVersion() +
          (isPendingSignal() ? 1 : 0) +
          (isSubmittingSignal() ? 1 : 0) +
          (isValidatingSignal() ? 1 : 0) +
          (formError()?.issues.length ?? 0)
        return changeToken
      },
      () => notify(),
    )

    return [store, setStore] as const
  })

  const rootFacade = facadeFor(store, [])

  // --- validation -------------------------------------------------------

  async function validateForm() {
    // validation must see the latest writes, even when triggered outside a flush
    flush()
    await hooks.callHook('beforeValidate')
    const rawData = untrack(() => clone(store))
    const result = (await Promise.resolve(
      standardSchema.validate(rawData),
    )) as StandardSchemaV1.Result<Schema>
    await hooks.callHook('afterValidate', result)

    if (!result.issues) {
      setFormError(undefined)
      return result.value
    }

    setFormError(result)

    for (const issue of result.issues) {
      if (!issue.path) continue
      if (deepestClaimant(issue)) continue
      console.warn('useForm: Detected validation issue in possibly unused field:', issue)
    }
  }

  /**
   * Finds the deepest materialized field along an issue's path — that field
   * claims the issue (direct matches and nested paths without their own field).
   */
  function deepestClaimant(issue: StandardSchemaV1.Issue): FormField<unknown, any> | undefined {
    const keys = issuePathKeys(issue.path)
    let record = ensureRecord(rootFacade)
    let deepest = record.self

    for (const key of keys) {
      const child = untrack(() => (record.facade as any)[key as any])
      const candidate =
        record.children.get(key as string | number) ??
        (isReferenceValue(child) ? nodes.get(child)?.self : undefined)
      if (candidate) deepest = candidate

      if (!isReferenceValue(child) || !nodes.has(child)) break
      record = nodes.get(child)!
    }

    return deepest
  }

  // --- field materialization -------------------------------------------

  function materialize(path: string): FormField<unknown, any> {
    const segments = parsePath(path)

    // walk containers down to the parent of the final segment
    let containerFacade = rootFacade
    let containerRecord = ensureRecord(rootFacade)
    let finalKey: string | number = ''
    let rawFinal: unknown = rootFacade
    let reference = true
    // true when an intermediate value is null/undefined (nullable object not filled yet)
    let chainBroken = false

    for (const [i, segment] of segments.entries()) {
      finalKey = segment.kind === 'index' ? segment.index : segment.key
      // reads through a facade return child facades (stable per raw object)
      rawFinal = untrack(() => (containerFacade as any)[finalKey])
      reference = isReferenceValue(rawFinal)

      if (i < segments.length - 1) {
        if (reference) {
          containerFacade = rawFinal as object
          containerRecord = ensureRecord(rawFinal as object)
        } else {
          chainBroken = true
        }
      }
    }

    const existing = chainBroken
      ? pathFields.get(path)
      : reference
        ? nodes.get(rawFinal as object)?.self
        : containerRecord.children.get(finalKey)
    if (existing) return existing

    debugLog(() => ['$use', path])

    let write: (value: unknown) => void
    let mergeWrite: ((value: unknown) => void) | undefined
    let containerMeta: FacadeMeta | undefined
    let elementTarget: object | undefined
    if (chainBroken) {
      // identity chain unavailable: fall back to a path-based write that
      // creates missing intermediate containers
      write = (value) => {
        if (blockedWhilePending()) return
        bump()
        setStore((root) => {
          setProperty(root as any, path, unwrapValue(value))
        })
      }
    } else {
      containerMeta = facadeMeta.get(containerFacade)!
      elementTarget =
        reference && rawFinal !== rootFacade
          ? facadeMeta.get(rawFinal as object)!.target
          : undefined
      const links: Link[] =
        rawFinal === rootFacade
          ? []
          : [
              ...containerMeta.links,
              {
                parent: containerMeta.target,
                key: finalKey,
                element: elementTarget,
              },
            ]
      write = (value) => mutateAt(links, value)
      if (reference && links.length > 0) {
        // reset merges the source snapshot into the live node so the field's
        // node identity (and with it dirty/error state of nested fields) survives
        mergeWrite = (value) => {
          if (blockedWhilePending()) return
          bump()
          setStore((root) => {
            const parent = resolveChain(root, links.slice(0, -1))
            if (parent === undefined || parent === null) return
            const key = refreshKey(links[links.length - 1]!)
            reconcile(clone(value), formOpts.reconcileKey ?? null)(parent[key])
          })
        }
      }
    }

    const bag: FormFieldBag<Schema> = {
      hooks,
      formOpts,
      jsonSchema,
      path,
      data: rootFacade,
      disabled: isDisabled,
      isLoading,
      isPending: () => isPendingValue,
      version,
      pristineVersion,
      formError,
      sourceSnapshot,
      validateForm,
      deepestClaimant,
      write,
      mergeWrite,
      valueFacade: !chainBroken && reference ? (rawFinal as object) : undefined,
      leafParent: !chainBroken && !reference ? containerFacade : undefined,
      leafKey: !chainBroken && !reference ? finalKey : undefined,
    }

    const field = new FormField(bag)

    if (chainBroken) {
      pathFields.set(path, field)
      return field
    }

    // accessor tree reachable from the field itself
    Object.defineProperty(field.api, '$', {
      enumerable: true,
      get: () => () => createFieldsProxy(field.api.path),
    })

    // framework adapter extensions (preserve getters)
    const extendHooks = formOpts[extend]
    if (extendHooks?.setup) {
      for (const [key, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(extendHooks.setup(field.api)),
      )) {
        Object.defineProperty(field.api, key, descriptor)
      }
    }
    if (extendHooks?.$use) {
      for (const [key, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(extendHooks.$use(field.api)),
      )) {
        Object.defineProperty(field.api, key, descriptor)
      }
    }
    if (reference) {
      // reference-node field: rides along with its datum through any mutation
      ensureRecord(rawFinal as object).self = field
    } else {
      // primitive-leaf field: cached on its parent under prop/index
      containerRecord.children.set(finalKey, field)
    }

    if (containerMeta && Array.isArray(containerMeta.target)) {
      deleters.set(field.api.key, () => {
        mutate(containerMeta.links, (array) => {
          const index = reference
            ? untrack(() => (array as unknown[]).indexOf(elementTarget))
            : untrack(() => (array as unknown[]).indexOf(field.api.value))
          ;(array as unknown[]).splice(index >= 0 ? index : Number(finalKey), 1)
        })
        deleters.delete(field.api.key)
      })
    }

    return field
  }

  function deleteByKey(key: string) {
    const deleter = deleters.get(key)
    if (!deleter) throw new Error('Key does not reference an array item')
    deleter()
  }

  // --- field accessors ---------------------------------------------------

  function childPath(path: string, key: string | number) {
    return typeof key === 'number' || (typeof key === 'string' && /^\d+$/.test(key))
      ? `${path}[${key}]`
      : path
        ? `${path}.${escapePathSegment(String(key))}`
        : escapePathSegment(String(key))
  }

  function createFieldsProxy(path = ''): BuildFormFieldAccessors<Data, false, true> {
    return new Proxy(Object.create(null) as BuildFormFieldAccessors<Data, false, true>, {
      ownKeys() {
        const fieldValue = untrack(() => getProperty(rootFacade, path, undefined))
        return fieldValue ? Object.keys(fieldValue) : []
      },
      getOwnPropertyDescriptor() {
        return { enumerable: true, configurable: true, writable: false }
      },
      has(_target, prop: string) {
        const fieldValue = untrack(() => getProperty(rootFacade, path, undefined))
        return Reflect.has(fieldValue ?? {}, prop)
      },
      get(_target, prop: string | symbol) {
        // don't entangle framework internals (@vue/reactivity flags, engine probes)
        if (typeof prop === 'string' && prop.startsWith('__')) return undefined

        if (prop === Symbol.iterator) {
          const array = getProperty(rootFacade, path, []) as unknown[] | null
          if (!Array.isArray(array)) return () => [].values()

          // index reads (not method calls) keep this tracked and facade-safe
          const accessors: BuildFormFieldAccessors<Data, false, true>[] = []
          for (let index = 0; index < array.length; index++) {
            accessors.push(createFieldsProxy(childPath(path, index)))
          }
          return () => accessors.values()
        }

        if (typeof prop === 'symbol') return

        if (prop === 'at') {
          return (index: number) => {
            const array = (getProperty(rootFacade, path, []) ?? []) as unknown[]
            const normalized = index >= 0 ? index : array.length + index
            return createFieldsProxy(childPath(path, normalized))
          }
        }

        if (prop === 'delete') {
          return (key: string) => {
            const array = getProperty(rootFacade, path, []) as unknown[] | null
            if (!array) throw new Error("Can't delete item when field is null")
            deleteByKey(key)
          }
        }

        if (prop === '$use') {
          return <T>($opts?: FormFieldAccessorOptions<T>) => {
            const field = materialize(path)

            const discriminator = $opts?.discriminator
            if (discriminator) {
              return {
                get [discriminator]() {
                  return (
                    (field.api.value as Record<string, unknown> | null)?.[discriminator] ?? null
                  )
                },
                get $field() {
                  return createFieldsProxy(field.api.path)
                },
              } as any
            }

            if ($opts?.translate) return field.translatedApi($opts.translate)
            return field.api
          }
        }

        return createFieldsProxy(childPath(path, prop))
      },
    })
  }

  // --- snapshot application ----------------------------------------------

  function applySnapshot(sourceValues: Data) {
    setStore(reconcile(clone(sourceValues), formOpts.reconcileKey ?? null))
    bump()
    markPristine()
    setFormError(undefined)
  }

  function reset() {
    debugLog(() => ['useForm: reset()'])
    applySnapshot(resolveSource() ?? ({} as Data))
  }

  /** Re-evaluates `sourceValues` and syncs the form (called by framework adapters). */
  function refresh() {
    const sourceValues = resolveSource()
    setSourceSnapshot(clone(sourceValues ?? ({} as Data)) as any)
    setIsPending(sourceValues === undefined)
    if (sourceValues === undefined) return

    if (isSubmittingValue) {
      queueReset = true
      debugLog(() => ['useForm: Queued reset after successful submit'])
      return
    }

    if (isDirty()) {
      /* TODO: update all untouched fields & show info on outdated fields.
        form.sourceValues + sourceValues.timestamp

        field.isTouched.timestamp > sourceValues.timestamp: field was changed normally (option: undo)
        field.isTouched.timestamp < sourceValues.timestamp: field is outdated (option: update)
      */
      console.warn('useForm:', 'Skipped sourceValues update after form was edited')
      return
    }

    applySnapshot(sourceValues)
  }

  setIsPending(resolveSource() === undefined)

  // apply the initial batch synchronously so the form is consistent on return
  flush()

  // --- form api ----------------------------------------------------------

  async function submit() {
    await hooks.callHook('beforeSubmit', { data: rootFacade as any })
    setIsValidating(true)

    try {
      const validatedValues = (await validateForm()) as unknown as StandardSchemaV1.Result<Schema>
      if (!validatedValues) {
        setIsValidating(false)

        const result = { success: false }
        await hooks.callHook('afterSubmit', result)
        return result
      }
      setIsValidating(false)

      const ctx = { values: validatedValues }
      setIsSubmitting(true)
      const submitResult = (await formOpts.submit(ctx as any)) ?? { success: true }
      setIsSubmitting(false)

      // don't reset because we don't want to overwrite the form data with the old sourceValues
      // (updates to sourceValues are handled by the adapter via refresh())
      // -> only mark the form as pristine
      if (submitResult.success) markPristine()

      await hooks.callHook('afterSubmit', submitResult)

      if (queueReset) {
        queueReset = false
        if (submitResult.success) reset()
      }

      return submitResult
    } catch (err) {
      console.error(err)
      setIsSubmitting(false)

      const result = { success: false }
      await hooks.callHook('afterSubmit', result)

      return result
    }
  }

  const fieldsProxy = createFieldsProxy()

  const formApi = {
    hooks: hooks as FormHooks<FormHookDefinitions<Schema>>,
    fields: fieldsProxy,
    get isDirty() {
      return isDirty()
    },
    get isChanged() {
      return !hasSubObject(sourceSnapshot() as object, store as object)
    },
    get isLoading() {
      return isLoading()
    },
    get isDisabled() {
      return isDisabled()
    },
    get data(): SourceValues extends undefined ? Data | undefined : Data {
      return (isPendingValue ? undefined : rootFacade) as any
    },
    get errors() {
      const issues = formError()?.issues
      return issues && hasAtLeast(issues, 1) ? issues : undefined
    },
    reset,
    submit,
    setData: (recipe: (draft: Data) => void) => {
      bump()
      setStore((draft) => {
        recipe(draft)
      })
    },
    ['~']: {
      flush,
      refresh,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }

  return formApi satisfies FormHandle & { fields: any; data: any }
}
