import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Form, Location, Segment } from './field'
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
  createMemo,
  createRoot,
  createSignal,
  createStore,
  deep,
  flush,
  getOwner,
  isWrappable,
  reconcile,
  runWithOwner,
  snapshot,
} from '@solidjs/signals'
import { createHooks } from 'hookable'
import { klona } from 'klona/full'
import { hasAtLeast, hasSubObject } from 'remeda'
import { FormField } from './field'
import { toJsonSchema } from './json-schema'
import { extend } from './types'
import { debugLog, toValue } from './util'

/**
 * Field cache mirroring the data tree. Object properties and primitive array elements are keyed
 * positionally, object array elements by the identity of their store node so they follow the datum.
 */
type CacheNode = {
  field?: FormField<unknown, any>
  children: Map<string | number, CacheNode>
  elements: WeakMap<object, CacheNode>
}
function cacheNode(): CacheNode {
  return { children: new Map(), elements: new WeakMap() }
}

const ARRAY_MUTATORS = new Set<PropertyKey>([
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

/** store node (object/array proxy) as opposed to a primitive or opaque leaf */
function isNode(value: unknown): value is object {
  return isWrappable(value)
}

const RAW = Symbol('raw')
function unwrapFacade(value: unknown) {
  return (isNode(value) && (value as { [RAW]?: object })[RAW]) || value
}
function normalizeKey(target: unknown, key: string | number) {
  return Array.isArray(target) && typeof key === 'string' && /^\d+$/.test(key) ? Number(key) : key
}
/** array elements that are nodes are addressed by identity, everything else by key */
function childSegment(parent: object, key: string | number, value: unknown): Segment {
  return Array.isArray(parent) && isNode(value) ? { el: value } : key
}

export type FormInternals = {
  /** synchronously apply pending writes (test/imperative escape hatch, validation stays async) */
  flush: () => void
  /** invoked after every flush that changed state readable through `scope` (form or field api) */
  subscribe: (listener: (scope: object) => void) => () => void
  dispose: () => void
}

export function useFormCore<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
  const Data extends FormData<Schema> = FormData<Schema>,
>(formOpts: FormOptions<Schema, SourceValues>) {
  return createRoot((dispose) => {
    const owner = getOwner()
    const hooks = createHooks<FormHookDefinitions<Schema>>()
    if (formOpts.hooks) hooks.addHooks(formOpts.hooks)

    const track = formOpts[extend]?.track ?? (() => {})
    const listeners = new Set<(scope: object) => void>()
    function notify(scope: object) {
      for (const listener of listeners) {
        // an uncaught error inside an effect halts the whole reactive system
        try {
          listener(scope)
        } catch (err) {
          console.error(err)
        }
      }
    }

    const sourceValues = createMemo(() => toValue(formOpts.sourceValues) as Data | undefined)
    const [isPristine, setIsPristine] = createSignal(true)
    const isPending = createMemo(() => sourceValues() === undefined)
    const [isSubmitting, setIsSubmitting] = createSignal(false)
    const [isValidating, setIsValidating] = createSignal(false)
    const isLoading = createMemo(() => isPending() || isValidating() || isSubmitting())
    const disabled = createMemo(() => isLoading() || (toValue(formOpts.disabled) ?? false))
    // equals: false so a whole-form validation always redistributes issues to the fields,
    // even when the form error stays undefined
    const [formError, setFormError] = createSignal<StandardSchemaV1.FailureResult | undefined>(
      undefined,
      { equals: false },
    )

    const [store, setStore] = createStore<{ data: object }>({ data: sourceValues() ?? {} })

    function reset() {
      debugLog(() => ['useForm: reset()'])

      setStore((s) => {
        reconcile(sourceValues() ?? {}, formOpts.key ?? null)(s.data)
      })
      setIsPristine(true)
      setFormError(undefined)
    }

    let queueReset = false
    createEffect(
      () => sourceValues(),
      () => {
        if (isSubmitting()) {
          queueReset = true
          debugLog(() => ['useForm: Queued reset after successful submit'])
          return
        }

        if (!isPristine()) {
          console.warn('useForm:', 'Skipped sourceValues update after form was edited')
          return
        }

        reset()
      },
      { defer: true },
    )

    const standardSchema = formOpts.schema['~standard']
    const jsonSchema = toJsonSchema(formOpts.schema)

    /** walks the store from the root, tracking every read */
    function resolve(segments: Segment[]): Location {
      const steps: Location['steps'] = []
      let parent: object | undefined = store
      let key: string | number = 'data'
      for (const segment of segments) {
        const container: unknown = parent && (parent as Record<string, unknown>)[key]
        parent = isNode(container) ? container : undefined
        if (typeof segment === 'object') {
          key = Array.isArray(parent) ? parent.indexOf(segment.el) : -1
          // element no longer in its array
          if (key === -1) return { steps, value: undefined, detached: true }
        } else key = normalizeKey(parent, segment)
        steps.push({ parent, key, value: parent && (parent as Record<string, unknown>)[key] })
      }
      return { steps, value: steps.length ? steps.at(-1)!.value : store.data, detached: false }
    }

    const rootCache = cacheNode()
    /** walks the field cache alongside the data, swapping index segments for element identity */
    function locate(segments: Segment[], create: boolean) {
      const { steps, detached } = resolve(segments)
      if (detached) return

      let node = rootCache
      const identitySegments: Segment[] = []
      for (const { parent, key, value } of steps) {
        const segment = parent ? childSegment(parent, key, value) : key
        identitySegments.push(segment)

        let next =
          typeof segment === 'object' ? node.elements.get(segment.el) : node.children.get(key)
        if (!next) {
          if (!create) return
          next = cacheNode()
          if (typeof segment === 'object') node.elements.set(segment.el, next)
          else node.children.set(key, next)
        }
        node = next
      }
      return { node, segments: identitySegments }
    }

    function write(segments: Segment[], value: unknown) {
      setStore((s) => {
        let parent: Record<string | number, unknown> = s
        let key: string | number = 'data'
        for (const segment of segments) {
          if (typeof segment !== 'object' && !isNode(parent[key]))
            parent[key] = typeof segment === 'number' ? [] : {}
          parent = parent[key] as Record<string | number, unknown>
          if (typeof segment === 'object') {
            key = Array.isArray(parent) ? parent.indexOf(segment.el) : -1
            if (key === -1) return
          } else key = segment
        }
        parent[key] = unwrapFacade(value)
      })
    }

    /** applies a user mutation at `segments`, marks the form dirty and re-validates the affected field */
    function mutate<R>(segments: Segment[], fn: () => R) {
      let result!: R
      setStore(() => {
        result = fn()
      })
      setIsPristine(false)
      void locate(segments, false)?.node.field?.validate()
      return result
    }

    const facades = new WeakMap<object, object>()
    /** writable view over a store node: reads pass through, writes go through the store setter */
    function facade(target: unknown, segments: Segment[] = []): unknown {
      if (!isNode(target)) return target
      const cached = facades.get(target)
      if (cached) return cached

      const proxy: object = new Proxy(target, {
        get(t, prop) {
          if (prop === RAW) return t
          track(formApi)
          const value: unknown = Reflect.get(t, prop)
          if (typeof prop === 'symbol') return value
          if (typeof value === 'function' && Array.isArray(t) && ARRAY_MUTATORS.has(prop)) {
            return (...args: unknown[]) =>
              mutate(segments, () => Reflect.apply(value, t, args.map(unwrapFacade)))
          }
          return facade(value, [...segments, childSegment(t, normalizeKey(t, prop), value)])
        },
        set(t, prop, value) {
          if (typeof prop === 'symbol') return Reflect.set(t, prop, value)
          mutate([...segments, normalizeKey(t, prop)], () =>
            Reflect.set(t, prop, unwrapFacade(value)),
          )
          return true
        },
        deleteProperty(t, prop) {
          if (typeof prop === 'symbol') return Reflect.deleteProperty(t, prop)
          mutate([...segments, normalizeKey(t, prop)], () => Reflect.deleteProperty(t, prop))
          return true
        },
      })
      facades.set(target, proxy)
      return proxy
    }

    async function validate() {
      return standardSchema.validate(klona(snapshot(store.data)))
    }

    const form: Form<Schema> = {
      hooks,
      opts: formOpts as FormOptions<Schema, FormSourceValues<Schema>>,
      jsonSchema,
      data: () => store.data,
      resolve,
      write,
      hasField: (path) =>
        locate(
          path.map(
            (segment) => (typeof segment === 'object' ? segment.key : segment) as string | number,
          ),
          false,
        )?.node.field !== undefined,
      facade,
      accessor,
      validate,
      disabled,
      isPending,
      isPristine,
      error: formError,
      setError: setFormError,
      sourceValues,
      markDirty: () => setIsPristine(false),
      track,
      notify,
    }

    function accessor(segments: Segment[]) {
      const value = () => {
        track(formApi)
        return resolve(segments).value
      }
      return new Proxy(Object.create(null) as BuildFormFieldAccessors<Data, false, true>, {
        ownKeys() {
          const fieldValue = value()
          return isNode(fieldValue) ? Object.keys(fieldValue) : []
        },
        getOwnPropertyDescriptor() {
          return { enumerable: true, configurable: true, writable: false }
        },
        has(_target, prop) {
          const fieldValue = value()
          return isNode(fieldValue) && Reflect.has(fieldValue, prop)
        },
        get(_target, prop: string | symbol) {
          if (prop === Symbol.iterator) {
            return () => {
              const fieldValue = value()
              return (
                Array.isArray(fieldValue)
                  ? fieldValue.map((_, index) => accessor([...segments, index]))
                  : []
              ).values()
            }
          }
          if (typeof prop === 'symbol') return

          if (prop === 'at') {
            return (index: number) => {
              const fieldValue = value()
              const length = Array.isArray(fieldValue) ? fieldValue.length : 0
              return accessor([...segments, index >= 0 ? index : length + index])
            }
          }

          if (prop === 'delete') {
            return (key: string) => {
              const fieldValue = value()
              if (!Array.isArray(fieldValue))
                throw new Error("Can't delete item when field is null")

              const node = locate(segments, false)?.node
              const index = fieldValue.findIndex(
                (item, i) =>
                  (isNode(item) ? node?.elements.get(item) : node?.children.get(i))?.field?.api
                    .key === key,
              )
              if (index === -1) throw new Error('Key does not reference an array item')

              mutate(segments, () => fieldValue.splice(index, 1))
            }
          }

          if (prop === '$use') {
            return <T>($opts?: FormFieldAccessorOptions<T>) => {
              const located = locate(segments, true)
              if (!located) throw new Error('Field references a removed array item')
              const field = (located.node.field ??= runWithOwner(
                owner,
                () => new FormField(located.segments, form),
              )!)

              const discriminator = $opts?.discriminator
              if (discriminator) {
                return {
                  get [discriminator]() {
                    return (
                      (field.api.value as Record<string, unknown> | null)?.[discriminator] ?? null
                    )
                  },
                  get $field() {
                    return accessor(field.segments)
                  },
                }
              }

              if ($opts?.translate)
                return runWithOwner(owner, () => field.translatedApi($opts.translate!))
              return field.api
            }
          }

          return accessor([...segments, prop])
        },
      })
    }

    async function validateForm() {
      await hooks.callHook('beforeValidate')
      const result = (await validate()) as StandardSchemaV1.Result<Schema>
      await hooks.callHook('afterValidate', result)

      if (!result.issues) {
        setFormError(undefined)
        return result.value
      }

      setFormError(result)

      for (const issue of result.issues) {
        if (!issue.path || form.hasField(issue.path)) continue
        console.warn('useForm: Detected validation issue in possibly unused field:', issue)
      }
    }

    const formApi = {
      'hooks': hooks as FormHooks<FormHookDefinitions<Schema>>,
      'fields': accessor([]),
      get 'isDirty'() {
        track(formApi)
        return !isPristine()
      },
      get 'isChanged'() {
        track(formApi)
        return isChanged()
      },
      get 'isLoading'() {
        track(formApi)
        return isLoading()
      },
      get 'isDisabled'() {
        track(formApi)
        return disabled()
      },
      get 'data'() {
        track(formApi)
        return (isPending() ? undefined : facade(store.data)) as SourceValues extends undefined
          ? Data | undefined
          : Data
      },
      get 'errors'() {
        track(formApi)
        const issues = formError()?.issues
        return issues && hasAtLeast(issues, 1) ? issues : undefined
      },
      reset,
      /** applies all mutations of `recipe` at once, followed by a single validation */
      'setData'(recipe: (data: Data) => void) {
        setStore((s) => {
          recipe(s.data as Data)
        })
        setIsPristine(false)
        void validateForm()
      },
      'submit': async () => {
        await hooks.callHook('beforeSubmit', { data: facade(store.data) as Data })
        let result = { success: false }

        try {
          setIsValidating(true)
          const values = await validateForm()
          setIsValidating(false)

          if (values) {
            setIsSubmitting(true)
            result = (await formOpts.submit({ values })) ?? { success: true }
            setIsSubmitting(false)

            // don't reset because we don't want to overwrite the form data with the old sourceValues
            // (updates to sourceValues are handled by the effect) -> only mark the form as pristine
            if (result.success) setIsPristine(true)
          }
        } catch (err) {
          console.error(err)
          setIsValidating(false)
          setIsSubmitting(false)
          result = { success: false }
        }

        await hooks.callHook('afterSubmit', result)

        if (queueReset) {
          queueReset = false
          if (result.success) reset()
        }

        return result
      },
      '~': {
        flush,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        dispose,
      } satisfies FormInternals,
    }

    const isChanged = createMemo(
      () => !hasSubObject<object, object>(sourceValues() ?? {}, deep(store.data)),
    )
    createEffect(
      () => {
        deep(store.data)
        isPristine()
        isChanged()
        isLoading()
        disabled()
        formError()
      },
      () => {
        notify(formApi)
      },
      { defer: true },
    )

    return formApi satisfies FormHandle & { fields: any; data: any }
  })
}
