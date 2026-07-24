import type { ToJsonSchema } from '@ark/schema'
import type { Owner } from '@solidjs/signals'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { JsonSchema } from 'json-schema-library'
import type { $ZodTypeDef, ToJSONSchemaParams } from 'zod/v4/core'
import type { FieldEnv, FieldOpts, PathSegment } from './field'
import type {
  BuildFormFieldAccessors,
  FormData,
  FormFieldAccessorOptions,
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
  deep,
  flush,
  getOwner,
  isWrappable,
  reconcile,
  snapshot,
  untrack,
} from '@solidjs/signals'
import { createHooks } from 'hookable'
import { klona } from 'klona/full'
import { hasAtLeast, hasSubObject } from 'remeda'
import { match } from 'ts-pattern'
import { FormField } from './field'
import { extend } from './types'
import { debugLog, pathSegmentsToPathString } from './util'

function clone<const T>(value: T): T {
  return klona(value)
}

function toVal<T>(v: T | (() => T) | { value: T } | undefined): T | undefined {
  if (typeof v === 'function') return (v as () => T)()
  if (v && typeof v === 'object' && 'value' in v) return v.value
  return v
}

const ARRAY_MUTATORS = new Set([
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

type ParentLink = { parent: object; arrayParent: boolean; key: PathSegment }

/** Coerce a proxy property key to a path segment (numeric index for arrays). */
function toSegment(prop: string, isArr: boolean): PathSegment {
  return isArr && /^\d+$/.test(prop) ? Number(prop) : prop
}

/** Walk `segments` from `root`, returning the node at that path. */
function nodeAt(root: unknown, segments: PathSegment[]) {
  let o = root as Record<PathSegment, unknown>
  for (const seg of segments) o = o[seg] as typeof o
  return o
}
function setByPath(draft: unknown, segments: PathSegment[], value: unknown) {
  if (segments.length === 0) return
  nodeAt(draft, segments.slice(0, -1))[segments.at(-1)!] = value
}
function deleteByPath(draft: unknown, segments: PathSegment[]) {
  if (segments.length === 0) return
  delete nodeAt(draft, segments.slice(0, -1))[segments.at(-1)!]
}

export function useFormCore<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
  const Data extends FormData<Schema> = FormData<Schema>,
>(formOpts: FormOptions<Schema, SourceValues>) {
  const hooks = createHooks<FormHookDefinitions<Schema>>()
  if (formOpts.hooks) hooks.addHooks(formOpts.hooks)

  const sourceValuesFn = (): Data | undefined => toVal(formOpts.sourceValues) as Data | undefined
  const reconcileKey = formOpts.reconcileKey ?? null

  // --- reactive state -------------------------------------------------------
  return createRoot(() => {
    const owner: Owner | null = getOwner()

    const initialSource = untrack(sourceValuesFn)

    const [store, setStore] = createStore<Data>(clone(initialSource ?? ({} as Data)) as never)
    const rootNode = store as unknown as object

    const [formUpdateCount, setFormUpdateCount] = createSignal(0)
    const [isPendingS, setPending] = createSignal(initialSource === undefined)
    const [isSubmitting, setSubmitting] = createSignal(false)
    const [formError, setFormError] = createSignal<StandardSchemaV1.FailureResult | undefined>(
      undefined,
    )

    const isDirty = () => formUpdateCount() !== 0
    const isPending = () => isPendingS()
    const isLoading = () => isSubmitting() || isPendingS()
    const disabled = () => isLoading() || (toVal(formOpts.disabled) ?? false)
    const snapshotData = () => snapshot(store) as object
    const isChanged = () => !hasSubObject(sourceValuesFn() ?? {}, snapshotData())

    // --- identity plumbing ----------------------------------------------------
    // Reference nodes are cached by store-node identity, so a field rides along
    // with its datum through any array mutation. Primitive leaves hang off the
    // parent node's entry (positional for arrays — the accepted hybrid).
    type Entry = {
      self?: FormField<unknown, Schema>
      children: Map<PathSegment, FormField<unknown, Schema>>
    }
    const nodeCache = new WeakMap<object, Entry>()
    const fallbackCache = new Map<string, FormField<unknown, Schema>>()
    const parentMap = new WeakMap<object, ParentLink>()
    const liveFields = new Set<FormField<unknown, Schema>>()

    function entryOf(node: object): Entry {
      let e = nodeCache.get(node)
      if (!e) {
        e = { children: new Map() }
        nodeCache.set(node, e)
      }
      return e
    }

    function link(parent: object, key: PathSegment, child: unknown) {
      if (isWrappable(child))
        parentMap.set(child as object, { parent, arrayParent: Array.isArray(parent), key })
    }

    function segmentsOfNode(node: object): PathSegment[] {
      if (node === rootNode) return []
      const e = parentMap.get(node)
      if (!e) return []
      const base = segmentsOfNode(e.parent)
      if (e.arrayParent) {
        const idx = (e.parent as unknown[]).indexOf(node)
        return [...base, idx === -1 ? Number(e.key) : idx]
      }
      return [...base, e.key]
    }

    function readAt(segments: PathSegment[]): unknown {
      let o: unknown = store
      for (const seg of segments) {
        if (!isWrappable(o)) return null
        o = (o as Record<PathSegment, unknown>)[seg]
      }
      if (o === undefined) return null
      return isWrappable(o) ? makeFacade(o, segments) : o
    }

    function write(segments: PathSegment[], value: unknown) {
      if (isPending()) return
      setStore((draft) => setByPath(draft, segments, value))
    }
    function bumpUpdateCount() {
      setFormUpdateCount((c) => c + 1)
    }

    // Collapse the store's pending write-override layer into the base by
    // reconciling the current snapshot into itself. This is transparent
    // (values and node identity are preserved) but is required before an
    // array reorder: the beta store otherwise clones any element that still
    // carries an override, which would sever its field's identity. Cheap for
    // form-sized data.
    // ponytail: O(n) snapshot+reconcile per reorder; fine at form scale.
    function bake() {
      flush()
      setStore(reconcile(snapshot(store) as Data, null))
      flush()
    }

    // --- writable facade ------------------------------------------------------
    // `form.data` / `field.value` for reference nodes: reads pass through to the
    // store (reactive, identity-stable); writes route into `setStore`.
    function makeFacade(node: object, segments: PathSegment[]): unknown {
      const isArr = Array.isArray(node)
      return new Proxy(node, {
        get(target, prop) {
          if (prop === Symbol.iterator && isArr) {
            const arr = node as unknown[]
            return function* () {
              for (let i = 0; i < arr.length; i++) yield readAt([...segments, i])
            }
          }
          if (typeof prop === 'symbol') return Reflect.get(target, prop) as unknown

          if (isArr && ARRAY_MUTATORS.has(prop)) {
            return (...args: unknown[]) => {
              if (isPending()) return
              bake()
              let result: unknown
              setStore((draft) => {
                const arr = nodeAt(draft, segments) as unknown as unknown[]
                result = (arr[prop as keyof unknown[]] as (...a: unknown[]) => unknown).apply(
                  arr,
                  args,
                )
              })
              bumpUpdateCount()
              return result
            }
          }

          const key = toSegment(prop, isArr)
          const value = (target as Record<PathSegment, unknown>)[key]
          if (typeof value === 'function') return (value as () => unknown).bind(target)
          if (isWrappable(value)) {
            link(node, key, value)
            return makeFacade(value as object, [...segments, key])
          }
          return value
        },
        set(_target, prop, value) {
          if (isPending()) return true
          if (typeof prop === 'symbol') return true
          setStore((draft) => setByPath(draft, [...segments, toSegment(prop, isArr)], value))
          bumpUpdateCount()
          return true
        },
        deleteProperty(_target, prop) {
          if (isPending()) return true
          if (typeof prop === 'symbol') return true
          setStore((draft) => deleteByPath(draft, [...segments, toSegment(prop, isArr)]))
          bumpUpdateCount()
          return true
        },
        has(target, prop) {
          return Reflect.has(target, prop)
        },
        ownKeys(target) {
          return Reflect.ownKeys(target)
        },
        getOwnPropertyDescriptor(target, prop) {
          return Reflect.getOwnPropertyDescriptor(target, prop)
        },
      })
    }

    // --- validation -----------------------------------------------------------
    const standardSchema = formOpts.schema['~standard']
    const jsonSchema = buildJsonSchema(standardSchema)

    async function validate() {
      await hooks.callHook('beforeValidate')
      const result = (await Promise.resolve(
        standardSchema.validate(snapshotData()),
      )) as StandardSchemaV1.Result<Schema>
      await hooks.callHook('afterValidate', result)

      if (!result.issues) {
        setFormError(undefined)
        const empty = new Set<string>()
        for (const f of liveFields) f.setValidationError(undefined, empty)
        return result.value
      }

      setFormError(result)
      const claimed = new Set([...liveFields].map((f) => f.path))
      for (const f of liveFields) f.setValidationError(result, claimed)

      for (const issue of result.issues) {
        if (!issue.path) continue
        const p = pathSegmentsToPathString(issue.path)
        if (!claimed.has(p))
          console.warn('useForm: Detected validation issue in possibly unused field:', issue)
      }
    }

    // on-change validation: revalidate live once data settles, but only while
    // the form already surfaces errors (so fixing an error clears it live).
    createEffect(
      () => {
        deep(store)
        return formUpdateCount()
      },
      () => {
        if (isLoading()) return
        if (untrack(() => formError()) !== undefined) void validate()
      },
      { defer: true },
    )

    // --- source values & reset ------------------------------------------------
    function applySource(sv: Data) {
      setStore(reconcile(clone(sv), reconcileKey))
      setFormUpdateCount(0)
      setFormError(undefined)
      const empty = new Set<string>()
      for (const f of liveFields) {
        f.markPristine()
        f.setValidationError(undefined, empty)
      }
    }

    function reset() {
      debugLog(() => ['useForm: reset()'])
      applySource(clone(untrack(sourceValuesFn) ?? ({} as Data)))
    }

    createEffect(
      sourceValuesFn,
      (sv) => {
        setPending(sv === undefined)
        if (sv === undefined) return
        if (isDirty() && !isSubmitting()) {
          console.warn('useForm:', 'Skipped sourceValues update after form was edited')
          return
        }
        applySource(sv)
      },
      { defer: true },
    )

    // --- field accessors ------------------------------------------------------
    const env: FieldEnv = {
      hooks: hooks as never,
      opts: formOpts as never,
      jsonSchema,
      owner,
      disabled: () => !!disabled(),
      isPending,
      isLoading,
      sourceValues: sourceValuesFn,
      snapshotData,
      formError,
      liveFields,
      segmentsOfNode,
      readAt,
      write,
      bumpUpdateCount,
      validate,
    }

    function resolve(segments: PathSegment[]) {
      let parent: unknown = store
      for (let i = 0; i < segments.length - 1; i++) {
        if (!isWrappable(parent)) {
          parent = undefined
          break
        }
        const next = untrack(() => (parent as Record<PathSegment, unknown>)[segments[i]!])
        link(parent as object, segments[i]!, next)
        parent = next
      }
      const last = segments.at(-1)!
      const value =
        segments.length === 0
          ? store
          : isWrappable(parent)
            ? untrack(() => (parent as Record<PathSegment, unknown>)[last])
            : undefined
      if (isWrappable(parent) && isWrappable(value)) link(parent as object, last, value)
      return { parent, last, value }
    }

    function resolveField(
      segments: PathSegment[],
      fieldOpts?: FieldOpts,
    ): FormField<unknown, Schema> {
      const { parent, last, value } = resolve(segments)

      if (segments.length === 0 || isWrappable(value)) {
        const node = (segments.length === 0 ? store : value) as object
        const e = entryOf(node)
        return (e.self ??= createField({ kind: 'node', node }, fieldOpts))
      }
      if (isWrappable(parent)) {
        const e = entryOf(parent as object)
        let f = e.children.get(last)
        if (!f) {
          f = createField({ kind: 'leaf', parent: parent as object, key: last }, fieldOpts)
          e.children.set(last, f)
        }
        return f
      }
      const pathStr = pathSegmentsToPathString(segments)
      let f = fallbackCache.get(pathStr)
      if (!f) {
        f = createField({ kind: 'fallback', segments }, fieldOpts)
        fallbackCache.set(pathStr, f)
      }
      return f
    }

    function createField(
      resolution: ConstructorParameters<typeof FormField>[1],
      fieldOpts?: FieldOpts,
    ): FormField<unknown, Schema> {
      const field = new FormField<unknown, Schema>(env, resolution, fieldOpts)
      Object.defineProperty(field.api, '$', {
        configurable: true,
        get() {
          return () => createFormFieldProxy(field.segments)
        },
      })
      Object.assign(field.api, formOpts[extend]?.setup?.(field.api))
      Object.assign(field.api, formOpts[extend]?.$use?.(field.api))
      return field
    }

    function createFormFieldProxy(
      segments: PathSegment[] = [],
      fieldOpts?: FieldOpts,
    ): BuildFormFieldAccessors<Data, false, true> {
      return new Proxy(Object.create(null) as BuildFormFieldAccessors<Data, false, true>, {
        ownKeys() {
          const value = untrack(() => readAt(segments))
          return value && typeof value === 'object' ? Object.keys(value) : []
        },
        getOwnPropertyDescriptor() {
          return { enumerable: true, configurable: true, writable: false }
        },
        has(_target, prop: string) {
          const value = untrack(() => readAt(segments)) as Record<string, unknown> | null
          return Reflect.has(value ?? {}, prop)
        },
        get(_target, prop: string | symbol) {
          if (prop === Symbol.iterator) {
            const value = untrack(() => readAt(segments)) as unknown[] | null
            if (!Array.isArray(value)) return () => [].values()
            return () =>
              value.map((_, index) => createFormFieldProxy([...segments, index])).values()
          }

          if (typeof prop === 'symbol') return

          if (prop === 'at') {
            return (index: number) => {
              const value = (untrack(() => readAt(segments)) ?? []) as unknown[]
              const i = index >= 0 ? index : value.length + index
              return createFormFieldProxy([...segments, i])
            }
          }

          if (prop === 'delete') {
            return (key: string) => {
              const array = untrack(() => readAt(segments)) as unknown[] | null
              if (!array) throw new Error("Can't delete item when field is null")

              const field = [...liveFields].find((f) => f.key === key)
              if (!field) throw new Error('Invalid key')

              const fieldSegments = field.segments
              const parentSegments = fieldSegments.slice(0, -1)
              const index = fieldSegments.at(-1)
              if (
                pathSegmentsToPathString(parentSegments) !== pathSegmentsToPathString(segments) ||
                typeof index !== 'number'
              )
                throw new Error('Key does not reference an array item')

              bake()
              setStore((draft) => {
                ;(nodeAt(draft, segments) as unknown as unknown[]).splice(index, 1)
              })
              bumpUpdateCount()
            }
          }

          if (prop === '$use') {
            return <T>($opts: FormFieldAccessorOptions<T>) => {
              const field = resolveField(segments, { ...fieldOpts, ...$opts })

              const discriminator = $opts?.discriminator
              if (discriminator) {
                return {
                  get [discriminator]() {
                    return (field.value as Record<string, unknown> | null)?.[discriminator] ?? null
                  },
                  get $field() {
                    return createFormFieldProxy(field.segments, { discriminator })
                  },
                }
              }

              if ($opts?.translate) return field.translatedApi($opts.translate)
              return field.api
            }
          }

          return createFormFieldProxy([...segments, toSegment(prop, true)])
        },
      })
    }

    // --- public handle --------------------------------------------------------
    const formApi = {
      'hooks': hooks as unknown as FormHooks<FormHookDefinitions<Schema>>,
      'fields': createFormFieldProxy(),
      get 'isDirty'() {
        return isDirty()
      },
      get 'isChanged'() {
        return isChanged()
      },
      get 'isLoading'() {
        return isLoading()
      },
      get 'isDisabled'() {
        return !!disabled()
      },
      get 'data'() {
        return (
          isPending() ? undefined : makeFacade(rootNode, [])
        ) as SourceValues extends undefined ? Data | undefined : Data
      },
      get 'errors'() {
        const err = formError()
        return err?.issues && hasAtLeast(err.issues, 1) ? err.issues : undefined
      },
      reset,
      'setData': (recipe: (draft: Data) => void) => {
        if (isPending()) return
        bake()
        setStore((draft) => {
          recipe(draft)
        })
        bumpUpdateCount()
      },
      'submit': async () => {
        flush()
        await hooks.callHook('beforeSubmit', { data: snapshotData() as FormData<Schema> })
        setSubmitting(true)

        try {
          const validationResult = await validate()
          if (validationResult === undefined) {
            setSubmitting(false)
            flush()
            const result = { success: false }
            await hooks.callHook('afterSubmit', result)
            return result
          }

          const submitResult = (await formOpts.submit({ values: validationResult })) ?? {
            success: true,
          }

          if (submitResult.success) {
            setFormUpdateCount(0)
            for (const f of liveFields) f.markPristine()
          }

          setSubmitting(false)
          flush()
          await hooks.callHook('afterSubmit', submitResult)
          return submitResult
        } catch (err) {
          console.error(err)
          setSubmitting(false)
          flush()
          const result = { success: false }
          await hooks.callHook('afterSubmit', result)
          return result
        }
      },
      // hidden internal bag (echoes the `~standard` convention): the async-write
      // escape hatch, plus the raw store node for framework adapters that must
      // observe deep changes (e.g. the Vue reactivity bridge).
      '~': {
        flush,
        store,
      },
    }

    return formApi
  })
}

function buildJsonSchema(standardSchema: FormSchema['~standard']): JsonSchema | undefined {
  const zodUnrepresentableTypes: Set<$ZodTypeDef['type']> = new Set([
    'bigint',
    'symbol',
    'undefined',
    'void',
    'date',
    'map',
    'set',
    'transform',
    'nan',
    'custom',
  ])

  const libraryOptions = match(standardSchema.vendor)
    .with(
      'zod',
      () =>
        ({
          unrepresentable: 'any',
          override(ctx) {
            const zod = ctx.zodSchema._zod
            if (zod.def.type === 'date') {
              ctx.jsonSchema.type = 'integer'
              ctx.jsonSchema.format = 'epoch'
              ctx.jsonSchema.minimum = (zod.bag.minimum as Date | undefined)?.getTime()
              ctx.jsonSchema.maximum = (zod.bag.maximum as Date | undefined)?.getTime()
              return
            }
            if (zodUnrepresentableTypes.has(ctx.zodSchema._zod.def.type)) {
              ctx.jsonSchema.type = 'object'
              ctx.jsonSchema.format = zod.def.type
            }
          },
        }) satisfies ToJSONSchemaParams,
    )
    .with(
      'arktype',
      () =>
        ({
          fallback: {
            default: (ctx) => ({ ...ctx.base, type: 'object', format: ctx.code }),
            date: (ctx) => ({
              ...ctx.base,
              type: 'integer',
              format: 'epoch',
              exclusiveMaximum: ctx.before?.getTime(),
              exclusiveMinimum: ctx.after?.getTime(),
            }),
          },
        }) satisfies ToJsonSchema.Options,
    )
    .otherwise(() => undefined)

  try {
    return standardSchema.jsonSchema.input({ target: 'draft-07', libraryOptions })
  } catch (err) {
    console.warn(
      'Failed to generate JSON Schema from Standard Schema. No schema information extraction possible.\n' +
        'Make sure your schema is compatible with JSON Schema Draft-07.\n' +
        'For non-representable data types, use a transformation/serializer that maps them to representable types. (e.g. Zod Codecs)\n\n' +
        'Error details:',
      err,
    )
    return undefined
  }
}
