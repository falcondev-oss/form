import type { StandardSchemaV1 } from '@standard-schema/spec'
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
import type { FormContext, FormField } from './field'
import {
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  runWithOwner,
  untrack,
} from '@solidjs/signals'
import { createHooks } from 'hookable'
import { klona } from 'klona/full'
import { hasAtLeast } from 'remeda'
import { createFormStore, toSegments } from './data'
import { assignDescriptors, createFormField } from './field'
import {
  applyArrayChange,
  deleteCacheItem,
  getCachedField,
  getCacheItem,
  setCachedField,
} from './field-cache'
import { toJsonSchema } from './json-schema'
import { commit, observe, toValue } from './reactive'
import { extend, setContext } from './types'
import { debugLog, escapePathSegment, hasSubObject, pathSegmentsToPathString } from './util'

export type { FieldCache } from './field-cache'

export function useFormCore<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
>(formOpts: FormOptions<Schema, SourceValues>) {
  // inside a Solid owner the form is disposed with it; otherwise it lives as long as it is referenced
  return createRoot(() => createForm<Schema, SourceValues>(formOpts))
}

function createForm<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema>,
  const Data extends FormData<Schema> = FormData<Schema>,
>(formOpts: FormOptions<Schema, SourceValues>) {
  const owner = getOwner()!
  const hooks = createHooks<FormHookDefinitions<Schema>>()
  if (formOpts.hooks) hooks.addHooks(formOpts.hooks)

  const sourceValues = createMemo(() => toValue(formOpts.sourceValues) as Data | undefined)
  const [updateCount, setUpdateCount] = createSignal(0)
  const isDirty = createMemo(() => updateCount() !== 0)
  const isPending = createMemo(() => sourceValues() === undefined)
  const [isSubmitting, setIsSubmitting] = createSignal(false)
  const [isValidating, setIsValidating] = createSignal(false)
  const isLoading = createMemo(() => isPending() || isValidating() || isSubmitting())
  const isDisabled = createMemo(() => isLoading() || (toValue(formOpts.disabled) ?? false))
  const [formError, setFormError] = createSignal<StandardSchemaV1.FailureResult | undefined>(
    undefined,
  )
  const errors = createMemo(() => {
    const issues = formError()?.issues
    return issues && hasAtLeast(issues, 1) ? issues : undefined
  })

  const fieldCache = {}
  const markEdited = () => setUpdateCount((c) => c + 1)

  const data = createFormStore(klona(untrack(sourceValues) ?? {}), {
    beforeReplace(path) {
      // a replaced array gets fresh item keys
      if (getCacheItem(fieldCache, path)?._array) deleteCacheItem(fieldCache, path)
    },
    beforeArrayChange: (path, change) => applyArrayChange(fieldCache, path, change),
    onWrite: markEdited,
    afterWrite: (path) => void getCachedField(fieldCache, path)?.validate(),
  })
  const formData = data.get([]) as Data

  const isChanged = createMemo(() => !hasSubObject(sourceValues() ?? {}, data.state))

  function reset() {
    debugLog(() => ['useForm: reset()'])

    commit(() => {
      data.replace(klona(untrack(sourceValues) ?? {}))
      setUpdateCount(0)
      setFormError(undefined)
    })
  }

  let queueReset = false
  observe(sourceValues, () => {
    if (isSubmitting()) {
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

    reset()
  })

  const standardSchema = formOpts.schema['~standard']
  const jsonSchema = toJsonSchema(formOpts.schema)

  const context: FormContext<Schema> = {
    owner,
    hooks,
    opts: formOpts as FormContext<Schema>['opts'],
    jsonSchema,
    fieldCache,
    data,
    sourceValues,
    formError,
    setFormError,
    markEdited,
    isDirty,
    isDisabled,
    isPending,
  }

  const discriminatedHandles = new WeakMap<FormField<unknown>, Map<string, object>>()

  /**
   * The handle `$use({ discriminator })` returns. Reading `handle[discriminator]`
   * is a tracked read of the live value, so after `if (handle.type === 'A')`
   * TypeScript narrows `handle.$field` and the check re-runs reactively.
   */
  function discriminatedHandle(field: FormField<unknown>, discriminator: string) {
    let byKey = discriminatedHandles.get(field)
    if (!byKey) discriminatedHandles.set(field, (byKey = new Map()))
    const cached = byKey.get(discriminator)
    if (cached) return cached

    const read = (key: PropertyKey) => {
      if (key === discriminator)
        return (field.api.value as Record<string, unknown> | null)?.[discriminator] ?? null
      if (key === '$field') return createFormFieldProxy(field.api.path)
    }
    const keys = [discriminator, '$field']
    const handle = new Proxy(Object.create(null) as object, {
      get: (_target, key) => read(key),
      has: (_target, key) => keys.includes(key as string),
      ownKeys: () => keys,
      getOwnPropertyDescriptor: (_target, key) =>
        keys.includes(key as string)
          ? { value: read(key), enumerable: true, configurable: true, writable: false }
          : undefined,
    })
    byKey.set(discriminator, handle)
    return handle
  }

  function useField(path: string, $opts?: FormFieldAccessorOptions<unknown>) {
    let field = getCachedField(fieldCache, path)
    if (field) {
      field.api[setContext]({ path })
    } else {
      debugLog(() => ['$use', path])

      const created = runWithOwner(owner, () => {
        const f = createFormField<unknown, Schema>(path, context)
        Object.assign(f.api, { $: () => createFormFieldProxy(f.api.path) })
        assignDescriptors(f.api, formOpts[extend]?.setup?.(f.api))
        assignDescriptors(f.api, formOpts[extend]?.$use?.(f.api))
        return f
      })
      setCachedField(fieldCache, path, created)
      field = created
    }

    if ($opts?.discriminator) return discriminatedHandle(field, $opts.discriminator)
    if ($opts?.translate) return field.translated($opts.translate)
    return field.api
  }

  function createFormFieldProxy(path = '') {
    const segments = toSegments(path)
    const readArray = () => data.read(segments) as unknown[] | null | undefined

    return new Proxy(Object.create(null) as BuildFormFieldAccessors<Data, false, true>, {
      ownKeys() {
        const fieldValue = data.read(segments)
        return fieldValue && typeof fieldValue === 'object' ? Object.keys(fieldValue) : []
      },
      getOwnPropertyDescriptor(_target, _key) {
        return { enumerable: true, configurable: true, writable: false }
      },
      has(_target, prop: string) {
        const fieldValue = data.read(segments)
        return !!fieldValue && typeof fieldValue === 'object' && Reflect.has(fieldValue, prop)
      },
      get(_target, prop: string | symbol) {
        if (prop === Symbol.iterator) {
          const array = readArray()
          if (array === null || array === undefined) return () => [].values()
          if (!Array.isArray(array)) return

          // reading `length` here too subscribes whoever fetches the iterator (e.g. the Vue bridge)
          void array.length
          return () =>
            Array.from({ length: array.length }, (_, i) =>
              createFormFieldProxy(`${path}[${i}]`),
            ).values()
        }

        if (typeof prop === 'symbol') return

        if (prop === 'at') {
          return (index: number) => {
            const length = readArray()?.length ?? 0
            return createFormFieldProxy(`${path}[${index >= 0 ? index : length + index}]`)
          }
        }

        if (prop === 'delete') {
          return (key: string) => {
            if (!readArray()) throw new Error("Can't delete item when field is null")

            const keyPath = key.match(/(.*)@[^@]+$/)?.[1]
            if (!keyPath) throw new Error('Invalid key')

            const index = keyPath.match(/\[(\d+)\]$/)?.[1]
            if (keyPath !== `${path}[${index}]` || index === undefined)
              throw new Error('Key does not reference an array item')

            // the key holds the item's index at creation; the cache knows where it moved since
            const currentIndex =
              getCacheItem(fieldCache, path)?._array?.findIndex(
                (item) => item?.$field?.api.key === key,
              ) ?? -1
            data.mutateArray(path, 'splice', [currentIndex >= 0 ? currentIndex : Number(index), 1])
          }
        }

        if (prop === '$use')
          return ($opts?: FormFieldAccessorOptions<unknown>) => useField(path, $opts)

        const propPath = path ? `${path}.${escapePathSegment(prop)}` : escapePathSegment(prop)
        return createFormFieldProxy(propPath)
      },
    })
  }

  async function validateForm() {
    await hooks.callHook('beforeValidate')
    const result = (await Promise.resolve(
      standardSchema.validate(data.snapshot()),
    )) as StandardSchemaV1.Result<Schema>
    await hooks.callHook('afterValidate', result)

    if (!result.issues) {
      commit(() => setFormError(undefined))
      return result.value
    }

    commit(() => setFormError(result))

    for (const issue of result.issues) {
      if (!issue.path) continue
      if (getCachedField(fieldCache, pathSegmentsToPathString(issue.path))) continue

      console.warn('useForm: Detected validation issue in possibly unused field:', issue)
    }
  }

  async function submit() {
    await hooks.callHook('beforeSubmit', { data: formData })
    commit(() => setIsValidating(true))

    try {
      const values = await validateForm()
      commit(() => setIsValidating(false))
      if (!values) {
        const result = { success: false }
        await hooks.callHook('afterSubmit', result)
        return result
      }

      commit(() => setIsSubmitting(true))
      const submitResult = (await formOpts.submit({ values })) ?? { success: true }
      // don't reset because we don't want to overwrite the form data with the old sourceValues
      // (updates to sourceValues are handled by the observer)
      // -> only set the update count to 0 to mark the form as pristine
      commit(() => {
        setIsSubmitting(false)
        if (submitResult.success) setUpdateCount(0)
      })

      await hooks.callHook('afterSubmit', submitResult)

      if (queueReset) {
        queueReset = false
        if (submitResult.success) reset()
      }

      return submitResult
    } catch (err) {
      console.error(err)
      commit(() => {
        setIsValidating(false)
        setIsSubmitting(false)
      })

      const result = { success: false }
      await hooks.callHook('afterSubmit', result)

      return result
    }
  }

  const fields = createFormFieldProxy()

  const formApi = {
    hooks: hooks as FormHooks<FormHookDefinitions<Schema>>,
    fields,
    get isDirty() {
      return isDirty()
    },
    get isChanged() {
      return isChanged()
    },
    get isLoading() {
      return isLoading()
    },
    get isDisabled() {
      return isDisabled()
    },
    get data() {
      return (isPending() ? undefined : formData) as SourceValues extends undefined
        ? Data | undefined
        : Data
    },
    get errors() {
      return errors()
    },
    reset,
    submit,
  }

  return formApi satisfies FormHandle
}
