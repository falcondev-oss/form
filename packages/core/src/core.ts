import type { StandardSchemaV1 } from '@standard-schema/spec'
import type {
  BuildFormFieldAccessors,
  FormData,
  FormFieldAccessorOptions,
  FormHandle,
  FormHookDefinitions,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from './types'
import type { FieldBinding, FieldForm } from './field'
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  createStore,
  flush,
  reconcile,
  snapshot,
  untrack,
} from '@solidjs/signals'
import { getProperty, setProperty } from 'dot-prop'
import { createHooks } from 'hookable'
import { hasAtLeast, hasSubObject, isDeepEqual } from 'remeda'
import { FormField } from './field'
import { clone, isReference, prepare, writable } from './reactive'
import { getSchemaMeta, toJsonSchema } from './json-schema'
import { extend } from './types'
import { pathSegmentsToPathString } from './util'

type Path = (string | number)[]

export function useFormCore<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
  const Data extends FormData<Schema> = FormData<Schema>,
>(formOpts: FormOptions<Schema, SourceValues>) {
  return createRoot((dispose) => {
    const hooks = createHooks<FormHookDefinitions<Schema>>()
    if (formOpts.hooks) hooks.addHooks(formOpts.hooks)
    const [options, setOptions] = createSignal(formOpts)
    const readSource = () => {
      const source = options().sourceValues
      return clone((typeof source === 'function' ? source() : source) as Data | undefined)
    }
    const [source, setSource] = createSignal<Data | undefined>(
      readSource() as Exclude<Data, Function> | undefined,
    )
    const [data, setData] = createStore<object>(clone(source() ?? ({} as Data))) as [
      Data,
      (recipe: (draft: Data) => Data | void) => void,
    ]
    const facade = writable(data) as Data
    const [dirty, setDirty] = createSignal(false)
    const [submitting, setSubmitting] = createSignal(false)
    const [validating, setValidating] = createSignal(false)
    const [errors, setErrors] = createSignal<readonly StandardSchemaV1.Issue[] | undefined>(
      undefined,
    )
    const pending = createMemo(() => source() === undefined)
    const loading = createMemo(() => pending() || submitting() || validating())
    const disabled = createMemo(() => {
      const option = options().disabled
      return loading() || (typeof option === 'function' ? option() : option) === true
    })
    const jsonSchema = toJsonSchema(formOpts.schema)
    const cache = new WeakMap<
      object,
      { self?: FormField<Schema>; children: Map<PropertyKey, FormField<Schema>> }
    >()
    const unresolved = new Set<WeakRef<FormField<Schema>>>()
    const fieldRefs = new Set<WeakRef<FormField<Schema>>>()
    function* fields() {
      for (const ref of fieldRefs) {
        const field = ref.deref()
        if (field) yield field
        else fieldRefs.delete(ref)
      }
    }
    const listeners = new Set<() => void>()
    let revision = 0
    let resetSnapshot: Data | undefined
    let pristineData = clone(data)
    let queueReset = false
    let validation = 0

    function entry(node: object) {
      let result = cache.get(node)
      if (!result) {
        result = { children: new Map() }
        cache.set(node, result)
      }
      return result
    }
    function read(path: Path): unknown {
      return path.reduce<unknown>(
        (value, key) => (value == null ? undefined : Reflect.get(Object(value), key)),
        data,
      )
    }
    // The engine exposes stable proxies, but no public reverse-path lookup.
    function locate(
      node: object,
      current: unknown = data,
      path: Path = [],
      seen = new Set<object>(),
    ): Path | undefined {
      if (current === node) return path
      if (!isReference(current) || seen.has(current as object)) return
      seen.add(current as object)
      for (const key of Object.keys(current as object)) {
        const found = locate(
          node,
          Reflect.get(current as object, key),
          [...path, Array.isArray(current) ? Number(key) : key],
          seen,
        )
        if (found) return found
      }
    }
    function write(path: Path | undefined, value: unknown) {
      if (!path || pending()) return
      value = prepare(value)
      if (!path.length) {
        setData(() => value as Data)
        return
      }
      setData((draft) => {
        setProperty(draft, path, value)
      })
    }
    function reset(key = null as FormOptions<Schema>['key']) {
      resetSnapshot = clone(source() ?? ({} as Data))
      pristineData = resetSnapshot
      validation++
      setData(reconcile(resetSnapshot, key ?? null))
      setDirty(false)
      setErrors(undefined)
      for (const field of fields()) field.clear()
      flush()
      resetSnapshot = undefined
    }
    function applyIssues(
      issues: readonly StandardSchemaV1.Issue[] | undefined,
      all: boolean | FormField<Schema>,
    ) {
      const claimed = new Set([...fields()].map((field) => field.binding.path()))
      for (const field of fields()) {
        if (all !== true && all !== field && !field.errors[0]()) continue
        const path = field.binding.path()
        const messages = issues
          ?.filter((issue) => {
            if (!issue.path || path === undefined) return false
            const issuePath = pathSegmentsToPathString(issue.path)
            return (
              issuePath === path ||
              ((path === '' ||
                issuePath.startsWith(`${path}.`) ||
                issuePath.startsWith(`${path}[`)) &&
                !claimed.has(issuePath))
            )
          })
          .map((issue) => issue.message)
        field.errors[1](messages?.length ? messages : undefined)
      }
    }
    async function validate(all: boolean | FormField<Schema> = true, withHooks = false) {
      const id = ++validation
      if (withHooks) await hooks.callHook('beforeValidate')
      const result = await formOpts.schema['~standard'].validate(clone(snapshot(data)))
      if (withHooks)
        await hooks.callHook('afterValidate', result as StandardSchemaV1.Result<Schema>)
      if (id === validation) {
        if (all === true || errors()) setErrors(result.issues)
        applyIssues(result.issues, all)
      }
      return result
    }
    const fieldForm: FieldForm<Schema> = {
      opts: formOpts,
      disabled,
      pending,
      loading,
      schema: (path) => (jsonSchema ? getSchemaMeta(jsonSchema, facade, path) : {}),
      validate: (field) => validate(field),
      change(field, value, write) {
        setDirty(true)
        void hooks.callHook('beforeFieldChange', field, value)
        write()
        void hooks.callHook('afterFieldChange', field, value)
      },
      extend(field) {
        Object.defineProperties(
          field,
          Object.getOwnPropertyDescriptors(formOpts[extend]?.setup?.(field) ?? {}),
        )
        Object.defineProperties(
          field,
          Object.getOwnPropertyDescriptors(formOpts[extend]?.$use?.(field) ?? {}),
        )
      },
    }

    function materialize(path: Path) {
      for (const ref of unresolved) {
        const pending = ref.deref()
        if (!pending) {
          unresolved.delete(ref)
          continue
        }
        if (pending.binding.path() === pathSegmentsToPathString(path)) return pending
      }
      const value = read(path)
      let parentPath = path.slice(0, -1)
      while (parentPath.length && !isReference(read(parentPath)))
        parentPath = parentPath.slice(0, -1)
      while (
        parentPath.length &&
        path.length - parentPath.length > 1 &&
        Array.isArray(read(parentPath))
      ) {
        parentPath = parentPath.slice(0, -1)
      }
      let parent = read(parentPath) as object
      let suffix = path.slice(parentPath.length)
      const reference = isReference(value) ? (value as object) : undefined
      const bucket = entry(reference ?? parent)
      const key = pathSegmentsToPathString(suffix)
      const cached = reference ? bucket.self : bucket.children.get(key)
      if (cached) return cached
      let pendingRef: WeakRef<FormField<Schema>> | undefined
      const currentPath = () => {
        if (!reference && suffix.length > 1) {
          const base = locate(parent)
          const full = base && [...base, ...suffix]
          const resolvedParent = full && read(full.slice(0, -1))
          if (isReference(resolvedParent)) {
            bucket.children.delete(key)
            parent = resolvedParent
            suffix = suffix.slice(-1)
            if (pendingRef) unresolved.delete(pendingRef)
            entry(parent).children.set(pathSegmentsToPathString(suffix), field)
          }
        }
        const base = locate(reference ?? parent)
        return base ? [...base, ...(reference ? [] : suffix)] : undefined
      }
      const binding: FieldBinding = {
        path: () => {
          const path = currentPath()
          return path && pathSegmentsToPathString(path)
        },
        value: () => {
          const path = currentPath()
          return path ? (path.length ? getProperty(facade, path) : facade) : undefined
        },
        source: () => {
          const path = currentPath()
          return path ? (path.length ? getProperty(source(), path) : source()) : undefined
        },
        write: (value) => write(currentPath(), value),
      }
      const field = new FormField(binding, fieldForm)
      field.api.$ = () =>
        accessor(() => {
          const current = currentPath()
          if (!current) throw new Error('Field is detached from the form')
          return current
        })
      fieldForm.extend(field.api)
      field.api = formOpts[extend]?.wrap?.(field.api) ?? field.api
      fieldRefs.add(new WeakRef(field))
      if (suffix.length > 1) {
        pendingRef = new WeakRef(field)
        unresolved.add(pendingRef)
      }
      if (reference) bucket.self = field
      else bucket.children.set(key, field)
      return field
    }
    function accessor(getPath: () => Path): BuildFormFieldAccessors<Data, false, true> {
      return new Proxy(Object.create(null) as BuildFormFieldAccessors<Data, false, true>, {
        ownKeys: () => Object.keys(Object(read(getPath()) ?? {})),
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
        has: (_, key) => Reflect.has(Object(read(getPath()) ?? {}), key),
        get(_, key) {
          if (key === Symbol.iterator)
            return function* () {
              const path = getPath()
              const value = read(path)
              if (!Array.isArray(value)) return
              for (let i = 0; i < value.length; i++) yield accessor(() => [...getPath(), i])
            }
          if (typeof key === 'symbol' || key === '__v_raw' || key === '__v_isRef') return
          if (key === 'at')
            return (index: number) =>
              accessor(() => {
                const path = getPath()
                const array = read(path)
                return [
                  ...path,
                  index < 0 ? (Array.isArray(array) ? array.length : 0) + index : index,
                ]
              })
          if (key === 'delete')
            return (key: string) => {
              const path = getPath()
              const value = read(path)
              if (!Array.isArray(value)) throw new Error("Can't delete item when field is null")
              const index = value.findIndex(
                (_, index) => materialize([...path, index]).api.key === key,
              )
              if (index < 0) throw new Error('Key does not reference an array item')
              setData((draft) => {
                ;(getProperty(draft, path) as unknown[]).splice(index, 1)
              })
            }
          if (key === '$use')
            return (opts?: FormFieldAccessorOptions<unknown>) => {
              const field = materialize(getPath())
              if (opts?.discriminator) {
                const discriminator = opts.discriminator
                const union = {
                  get [discriminator]() {
                    return Reflect.get(Object(field.api.value ?? {}), discriminator) ?? null
                  },
                  get $field() {
                    return accessor(getPath)
                  },
                }
                return formOpts[extend]?.wrap?.(union) ?? union
              }
              return opts?.translate ? field.translatedApi(opts.translate, fieldForm) : field.api
            }
          return accessor(() => [...getPath(), key])
        },
      })
    }

    createEffect(
      readSource,
      (value) =>
        untrack(() => {
          if (isDeepEqual(value, source())) return
          const hasPendingEdit = !isDeepEqual(clone(data), pristineData)
          setSource(() => value)
          if (submitting()) {
            queueReset = true
            return
          }
          if (dirty() || hasPendingEdit) {
            console.warn('useForm:', 'Skipped sourceValues update after form was edited')
            return
          }
          // Reconcile against the new source in the same batch.
          validation++
          setErrors(undefined)
          for (const field of fields()) field.clear()
          resetSnapshot = clone(value ?? ({} as Data))
          pristineData = resetSnapshot
          setData(reconcile(resetSnapshot, formOpts.key ?? null))
        }),
      { defer: true },
    )
    // rc.6 deep() misses nested writes after a sibling edit; proxy reads track them.
    createEffect(
      () => clone(data),
      (value) => {
        const wasReset = resetSnapshot !== undefined && isDeepEqual(value, resetSnapshot)
        resetSnapshot = undefined
        if (wasReset) return
        setDirty(true)
        void validate(false)
      },
      { defer: true },
    )
    createEffect(
      () => {
        clone(data)
        dirty()
        loading()
        disabled()
        errors()
        for (const field of fields()) {
          field.errors[0]()
          field.dirty[0]()
        }
        return {}
      },
      () => {
        revision++
        for (const listener of listeners) untrack(listener)
      },
      { defer: true },
    )

    const form = {
      hooks,
      'fields': accessor(() => []),
      get 'data'() {
        return (pending() ? undefined : facade) as SourceValues extends undefined
          ? Data | undefined
          : Data
      },
      get 'isDirty'() {
        return dirty()
      },
      get 'isChanged'() {
        return !hasSubObject<object, object>(source() ?? {}, data)
      },
      get 'isLoading'() {
        return loading()
      },
      get 'isDisabled'() {
        return disabled()
      },
      get 'errors'() {
        const value = errors()
        return value && hasAtLeast(value, 1) ? value : undefined
      },
      'reset': () => reset(),
      'setData'(recipe: (draft: Data) => void) {
        if (!pending())
          setData(() => {
            recipe(facade)
          })
      },
      '~': {
        flush,
        dispose,
        subscribe(this: void, listener: () => void) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        getSnapshot: () => revision,
        updateOptions: (next: FormOptions<Schema, SourceValues>) => setOptions(() => next),
      },
      async 'submit'() {
        flush()
        await hooks.callHook('beforeSubmit', { data: facade })
        setValidating(true)
        try {
          const result = await validate(true, true)
          setValidating(false)
          if (result.issues) {
            await hooks.callHook('afterSubmit', { success: false })
            return { success: false }
          }
          setSubmitting(true)
          flush()
          const submitted = (await options().submit({
            values: result.value as StandardSchemaV1.InferOutput<Schema>,
          })) ?? { success: true }
          flush()
          setSubmitting(false)
          if (submitted.success) {
            pristineData = clone(data)
            setDirty(false)
            for (const field of fields()) field.clear()
          }
          await hooks.callHook('afterSubmit', submitted)
          if (queueReset) {
            queueReset = false
            if (submitted.success) reset(formOpts.key)
          }
          flush()
          return submitted
        } catch (error) {
          console.error(error)
          setSubmitting(false)
          await hooks.callHook('afterSubmit', { success: false })
          return { success: false }
        } finally {
          setValidating(false)
          flush()
        }
      },
    }
    return (formOpts[extend]?.wrap?.(form) ?? form) satisfies FormHandle
  })
}
