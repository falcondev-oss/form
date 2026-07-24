import type { ToJsonSchema } from '@ark/schema'
import type { StoreSetter } from '@solidjs/signals'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { JsonSchema } from 'json-schema-library'
import type { $ZodTypeDef, ToJSONSchemaParams } from 'zod/v4/core'
import type { FieldBinding, FieldOpts, FormInternal, FormRuntime } from './field'
import type {
  BuildFormFieldAccessors,
  FormData,
  FormFieldAccessorOptions,
  FormFieldInternal,
  FormHandle,
  FormHookDefinitions,
  FormHooks,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from './types'
import {
  $TARGET,
  createEffect,
  createStore,
  deep,
  flush,
  reconcile,
  snapshot,
} from '@solidjs/signals'
import { createHooks } from 'hookable'
import { hasAtLeast, hasSubObject, isDeepEqual } from 'remeda'
import { match } from 'ts-pattern'
import { FormField } from './field'
import { getSchemaMeta } from './schema-meta'
import { extend } from './types'
import { debugLog, pathSegmentsToPathString } from './util'

type Path = PropertyKey[]
type Internal = FormInternal & {
  updateSource: (value: unknown) => void
  updateSubmit: (submit: FormOptions<FormSchema>['submit']) => void
  notify: () => void
}

function clone<const T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T
  if (
    value === null ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    return value

  const result: Record<PropertyKey, unknown> = {}
  for (const key of Reflect.ownKeys(value))
    result[key] = clone((value as Record<PropertyKey, unknown>)[key])
  return result as T
}

function toValue<T>(value: T | (() => T) | { readonly value: T }): T {
  if (typeof value === 'function') return (value as () => T)()
  if (value && typeof value === 'object' && 'value' in value) return value.value
  return value
}

function getAt(value: unknown, path: Path): unknown {
  let current = value
  for (const segment of path) current = (current as Record<PropertyKey, unknown>)?.[segment]
  return current
}

function setAt(value: object, path: Path, next: unknown) {
  if (path.length === 0) return
  const parent = getAt(value, path.slice(0, -1)) as Record<PropertyKey, unknown>
  parent[path.at(-1)!] = next
}

function findPath(root: object, target: object): Path | undefined {
  const seen = new WeakSet<object>()
  const targetNode = nodeIdentity(target)

  function visit(value: unknown, path: Path): Path | undefined {
    if (isReference(value) && nodeIdentity(value) === targetNode) return path
    if (!isReference(value) || seen.has(value)) return
    seen.add(value)

    for (const key of Object.keys(value)) {
      const found = visit((value as Record<string, unknown>)[key], [
        ...path,
        Array.isArray(value) ? Number(key) : key,
      ])
      if (found) return found
    }
  }

  return visit(root, [])
}

function pathKey(path: Path) {
  return pathSegmentsToPathString(path)
}

function isReference(value: unknown): value is object {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return false
  const raw = rawValue(value)
  const prototype = Reflect.getPrototypeOf(raw)
  return Array.isArray(raw) || prototype === Object.prototype || prototype === null
}

function nodeIdentity(value: object): object {
  return (value as Record<PropertyKey, object>)[$TARGET] ?? value
}

function rawValue(value: object): object {
  return (nodeIdentity(value) as { v?: object }).v ?? value
}

export function useFormCore<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
  const Data extends FormData<Schema> = FormData<Schema>,
>(formOpts: FormOptions<Schema, SourceValues>) {
  const hooks = createHooks<FormHookDefinitions<Schema>>()
  if (formOpts.hooks) hooks.addHooks(formOpts.hooks)

  let submit = formOpts.submit
  let source = clone(toValue(formOpts.sourceValues) as Data | undefined)
  let updateCount = 0
  let formError: StandardSchemaV1.FailureResult | undefined
  let isPending = source === undefined
  let isSubmitting = false
  let validationId = 0
  let suppressNextChange = false
  let version = 0
  const listeners = new Set<() => void>()
  const [store, setStore] = createStore(clone(source ?? {})) as unknown as [
    Readonly<Data>,
    StoreSetter<Data>,
  ]

  const notify = () => {
    version++
    for (const listener of listeners) listener()
  }
  const internal: Internal = {
    flush() {
      flush()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => version,
    updateSource(value) {
      applySource(value as Data | undefined)
    },
    updateSubmit(nextSubmit) {
      submit = nextSubmit
    },
    notify,
  }

  const standardSchema = formOpts.schema['~standard']
  debugLog(() => ['standardSchema', standardSchema])

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

  let jsonSchema: JsonSchema | undefined
  try {
    jsonSchema = standardSchema.jsonSchema.input({ target: 'draft-07', libraryOptions })
  } catch (err) {
    console.warn(
      'Failed to generate JSON Schema from Standard Schema. No schema information extraction possible.\n' +
        'Make sure your schema is compatible with JSON Schema Draft-07.\n' +
        'For non-representable data types, use a transformation/serializer that maps them to representable types. (e.g. Zod Codecs)\n\n' +
        'Error details:',
      err,
    )
  }

  const referenceFields = new WeakMap<object, FormField<unknown, Schema>>()
  const childFields = new WeakMap<object, Map<PropertyKey, FormField<unknown, Schema>>>()
  const pathFields = new Map<string, FormField<unknown, Schema>>()
  const fieldsByKey = new Map<string, FormField<unknown, Schema>>()
  const allFields = new Set<FormField<unknown, Schema>>()
  const facades = new WeakMap<object, object>()
  const facadeTargets = new WeakMap<object, object>()
  const rawTokens = new WeakMap<object, object>()
  const nodeTokens = new WeakMap<object, object>()
  const currentNodes = new WeakMap<object, object>()
  const storeValue = 'v'
  let runtime!: FormRuntime<Schema>

  function fieldIdentity(value: object) {
    const node = nodeIdentity(value)
    let token = nodeTokens.get(node)
    const raw = (node as { [storeValue]?: object })[storeValue]
    token ??= (raw && rawTokens.get(raw)) || node
    nodeTokens.set(node, token)
    if (!currentNodes.has(token) || findPath(store, value)) currentNodes.set(token, value)
    return token
  }

  function currentNode(value: object) {
    return currentNodes.get(fieldIdentity(value)) ?? value
  }

  function bindingPath(binding: FieldBinding): Path {
    if (binding.kind === 'path') return binding.segments
    if (binding.kind === 'reference') return findPath(store, currentNode(binding.value)) ?? []
    const parent = findPath(store, currentNode(binding.parent))
    return parent ? [...parent, binding.key] : []
  }

  function readBinding(binding: FieldBinding) {
    if (binding.kind === 'reference') return currentNode(binding.value)
    if (binding.kind === 'leaf')
      return (currentNode(binding.parent) as Record<PropertyKey, unknown>)[binding.key]
    return getAt(store, binding.segments)
  }

  function writeBinding(binding: FieldBinding, value: unknown) {
    const path = bindingPath(binding)
    const next = isReference(value) && $TARGET in value ? snapshot(value) : value
    if (path.length === 0 && isReference(next)) {
      setStore(reconcile(clone(next) as Data, null))
      return
    }
    if (binding.kind === 'leaf') {
      writeProperty(currentNode(binding.parent), binding.key, next)
      return
    }
    if (binding.kind === 'reference' && isReference(next))
      rawTokens.set(next, fieldIdentity(binding.value))
    setStore((draft) => setAt(draft, path, next))
  }

  function writeProperty(parent: object, key: PropertyKey, value: unknown, deleting = false) {
    const path = findPath(store, parent)
    if (!path) return
    const next = isReference(value) ? (facadeTargets.get(value) ?? value) : value
    if (path.length === 0 || Array.isArray(parent)) {
      setStore((draft) => {
        const target = getAt(draft, path) as Record<PropertyKey, unknown>
        if (deleting) delete target[key]
        else target[key] = next
      })
      return
    }

    const replacement = { ...snapshot(parent) } as Record<PropertyKey, unknown>
    if (deleting) delete replacement[key]
    else replacement[key] = next
    rawTokens.set(replacement, fieldIdentity(parent))
    setStore((draft) => setAt(draft, path, replacement))
  }

  function resolveBinding(path: Path): FieldBinding {
    const value = getAt(store, path)
    if (isReference(value)) return { kind: 'reference', value }

    const parent = getAt(store, path.slice(0, -1))
    if (isReference(parent)) return { kind: 'leaf', parent, key: path.at(-1)! }

    return { kind: 'path', segments: path }
  }

  function fieldFor(path: Path, opts?: FieldOpts) {
    const binding = resolveBinding(path)
    let field: FormField<unknown, Schema> | undefined

    if (binding.kind === 'reference') {
      field = referenceFields.get(fieldIdentity(binding.value))
    } else if (binding.kind === 'leaf') {
      field = childFields.get(fieldIdentity(binding.parent))?.get(binding.key)
    } else {
      field = pathFields.get(pathKey(path))
    }

    if (field) return field

    field = new FormField(binding, runtime, opts)
    if (binding.kind === 'reference') {
      referenceFields.set(fieldIdentity(binding.value), field)
    } else if (binding.kind === 'leaf') {
      const parent = fieldIdentity(binding.parent)
      let children = childFields.get(parent)
      if (!children)
        childFields.set(parent, (children = new Map<PropertyKey, FormField<unknown, Schema>>()))
      children.set(binding.key, field)
    } else {
      pathFields.set(pathKey(path), field)
    }
    fieldsByKey.set(field.api.key, field)
    allFields.add(field)
    return field
  }

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

  function facade<T>(value: T): T {
    if (!isReference(value))
      return (value && typeof value === 'object' ? rawValue(value) : value) as T
    const cached = facades.get(value)
    if (cached) return cached as T

    const proxy = new Proxy(value, {
      get(target, property, receiver: object): unknown {
        if (Array.isArray(target) && typeof property === 'string' && arrayMutators.has(property)) {
          return (...args: unknown[]) => {
            const copy = Array.from(target as unknown[], (item) => facade(item))
            const storeArgs = args.map((arg) =>
              isReference(arg) ? (facadeTargets.get(arg) ?? arg) : arg,
            )
            const method = Array.prototype[property as keyof unknown[]] as (
              ...values: unknown[]
            ) => unknown
            const result = method.apply(copy, args)
            const path = findPath(store, target)
            if (!path) return result
            setStore((draft) => {
              const array = getAt(draft, path) as unknown[]
              method.apply(array, storeArgs)
            })
            return result === copy ? receiver : result
          }
        }

        const result = (target as Record<PropertyKey, unknown>)[property]
        if (typeof result !== 'function') return facade(result)
        const method = result as (...args: unknown[]) => unknown
        return (...args: unknown[]) => method.apply(receiver, args)
      },
      set(target, property, next) {
        const path = findPath(store, target)
        if (!path) return false
        writeProperty(target, property, next)
        return true
      },
      deleteProperty(target, property) {
        const path = findPath(store, target)
        if (!path) return false
        writeProperty(target, property, undefined, true)
        return true
      },
    })
    facades.set(value, proxy)
    facadeTargets.set(proxy, value)
    return proxy
  }

  async function validateForm() {
    const id = ++validationId
    await hooks.callHook('beforeValidate')
    const result = (await Promise.resolve(
      standardSchema.validate(snapshot(store)),
    )) as StandardSchemaV1.Result<Schema>
    await hooks.callHook('afterValidate', result)
    if (id === validationId) {
      formError = result.issues ? result : undefined
      notify()
    }
    return result.issues ? undefined : result.value
  }

  runtime = {
    hooks,
    track: () => formOpts[extend]?.track?.(),
    disabled: () =>
      isSubmitting || isPending || (formOpts.disabled ? toValue(formOpts.disabled) : false),
    isPending: () => isPending,
    read: readBinding,
    write: writeBinding,
    source: (binding) => getAt(source, bindingPath(binding)),
    path: (binding) => pathKey(bindingPath(binding)),
    facade,
    validate: validateForm,
    issues(path) {
      if (!formError) return []
      return formError.issues.filter((issue) => {
        if (!issue.path) return false
        const issuePath = pathSegmentsToPathString(issue.path)
        if (issuePath === path) return true
        if (!issuePath.startsWith(path)) return false
        return ![...allFields].some(
          (field) => field.api.path !== path && field.api.path === issuePath,
        )
      })
    },
    schemaMeta: (path, opts) =>
      jsonSchema ? getSchemaMeta(jsonSchema, facade(store), path, opts) : {},
    notifyFieldStateChange: notify,
    internal,
  }

  function createFormFieldProxy(path: Path = [], fieldOpts?: FieldOpts) {
    return new Proxy(Object.create(null) as BuildFormFieldAccessors<Data, false, true>, {
      ownKeys() {
        const value = getAt(store, path)
        return value ? Object.keys(value) : []
      },
      getOwnPropertyDescriptor() {
        return { enumerable: true, configurable: true, writable: false }
      },
      has(_target, property: string) {
        const value = getAt(store, path)
        return Reflect.has((value as object | undefined) ?? {}, property)
      },
      get(_target, property: string | symbol) {
        if (property === Symbol.iterator) {
          const value = getAt(store, path)
          if (value === null) return () => [].values()
          if (!Array.isArray(value)) return
          return () => value.map((_, index) => createFormFieldProxy([...path, index])).values()
        }
        if (typeof property === 'symbol') return
        if (property === 'at') {
          return (index: number) => {
            const value = (getAt(store, path) ?? []) as unknown[]
            return createFormFieldProxy([...path, index >= 0 ? index : value.length + index])
          }
        }
        if (property === 'delete') {
          return (key: string) => {
            const array = getAt(store, path)
            if (array === null) throw new Error("Can't delete item when field is null")
            if (!Array.isArray(array)) throw new Error('Field is not an array')

            const field = fieldsByKey.get(key)
            if (!field) throw new Error('Invalid key')
            const itemPath = bindingPath(field.binding)
            const index = itemPath.at(-1)
            if (typeof index !== 'number' || pathKey(itemPath.slice(0, -1)) !== pathKey(path))
              throw new Error('Key does not reference an array item')

            setStore((draft) => {
              ;(getAt(draft, path) as unknown[]).splice(index, 1)
            })
          }
        }
        if (property === '$use') {
          return <T>($opts?: FormFieldAccessorOptions<T>) => {
            const field = fieldFor(path, fieldOpts)
            if (!field.api.$) {
              Object.defineProperty(field.api, '$', {
                value: () => createFormFieldProxy(bindingPath(field.binding)),
              })
              const extension = formOpts[extend]?.setup?.(field.api)
              if (extension)
                Object.defineProperties(field.api, Object.getOwnPropertyDescriptors(extension))
            }

            if ($opts?.discriminator) {
              const discriminator = $opts.discriminator
              return {
                get [discriminator]() {
                  return (
                    (field.api.value as Record<string, unknown> | null)?.[discriminator] ?? null
                  )
                },
                get $field() {
                  return createFormFieldProxy(bindingPath(field.binding), { discriminator })
                },
              }
            }

            const api = $opts?.translate ? field.translatedApi($opts.translate as never) : field.api
            const extension = formOpts[extend]?.$use?.(api as FormFieldInternal<any>)
            if (extension) Object.defineProperties(api, Object.getOwnPropertyDescriptors(extension))
            return api
          }
        }

        return createFormFieldProxy([...path, property])
      },
    })
  }

  function restoreSource(reconcileKey: FormOptions<Schema>['reconcileKey']) {
    const next = clone(source ?? ({} as Data))
    suppressNextChange = !isDeepEqual(snapshot(store), next)
    setStore(reconcile(next, reconcileKey ?? null))
    updateCount = 0
    formError = undefined
    for (const field of allFields) field.markPristine()
    notify()
  }

  function reset() {
    debugLog(() => ['useForm: reset()'])
    restoreSource(undefined)
  }

  function applySource(value: Data | undefined) {
    if (isDeepEqual(source, value)) return
    isPending = value === undefined
    source = clone(value)

    if (updateCount !== 0 && !isSubmitting) {
      console.warn('useForm:', 'Skipped sourceValues update after form was edited')
      notify()
      return
    }
    restoreSource(formOpts.reconcileKey)
  }

  createEffect(
    () => deep(store),
    () => {
      if (suppressNextChange) suppressNextChange = false
      else {
        updateCount++
        void validateForm()
      }
      notify()
    },
    { defer: true, sync: true },
  )

  if (typeof formOpts.sourceValues === 'function') {
    createEffect(
      () => toValue(formOpts.sourceValues),
      (value) => applySource(value as Data | undefined),
      { defer: true, sync: true },
    )
  }

  const formApi = {
    'hooks': hooks as FormHooks<FormHookDefinitions<Schema>>,
    'fields': {} as BuildFormFieldAccessors<Data, false, true>,
    get 'isDirty'() {
      return updateCount !== 0
    },
    get 'isChanged'() {
      return !hasSubObject<object, object>(source ?? {}, snapshot(store))
    },
    get 'isLoading'() {
      return isSubmitting || isPending
    },
    get 'isDisabled'() {
      return runtime.disabled()
    },
    get 'data'() {
      return (isPending ? undefined : facade(store)) as SourceValues extends undefined
        ? Data | undefined
        : Data
    },
    get 'errors'() {
      return formError?.issues && hasAtLeast(formError.issues, 1) ? formError.issues : undefined
    },
    reset,
    'setData': function (recipe: (data: Data) => void) {
      setStore(recipe)
    },
    'submit': async function () {
      flush()
      isSubmitting = true
      notify()
      await hooks.callHook('beforeSubmit', { data: facade(store) as Data })

      try {
        const validationResult = await validateForm()
        if (!validationResult) {
          isSubmitting = false
          const result = { success: false }
          await hooks.callHook('afterSubmit', result)
          notify()
          return result
        }

        const submitResult = (await submit({ values: validationResult })) ?? { success: true }
        flush()
        if (submitResult.success) {
          updateCount = 0
          for (const field of allFields) field.markPristine()
        }
        isSubmitting = false
        await hooks.callHook('afterSubmit', submitResult)
        notify()
        return submitResult
      } catch (err) {
        console.error(err)
        isSubmitting = false
        const result = { success: false }
        await hooks.callHook('afterSubmit', result)
        notify()
        return result
      }
    },
    '~': internal,
  }

  formApi.fields = createFormFieldProxy()
  return formApi satisfies FormHandle & {
    fields: BuildFormFieldAccessors<Data, false, true>
    data: SourceValues extends undefined ? Data | undefined : Data
    setData: (recipe: (data: Data) => void) => void
  }
}
