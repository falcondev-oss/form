import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { ComputedRef, Ref } from '@vue/reactivity'
import type {
  BuildFormFieldAccessors,
  FormData,
  FormFieldAccessorOptions,
  FormHandle,
  FormHookDefinitions,
  FormHooks,
  FormOptions,
  FormSchema,
} from './types'
import { computed, reactive, ref, toValue, watch } from '@vue/reactivity'
import { deleteProperty, getProperty, setProperty } from 'dot-prop'
import { createHooks } from 'hookable'
import { klona } from 'klona/full'
import onChange from 'on-change'
import { hasAtLeast, hasSubObject, isArray } from 'remeda'
import { match, P } from 'ts-pattern'
import { FormField } from './field'
import { toReactive } from './reactive'
import { extend, setContext } from './types'
import { escapePathSegment, pathSegmentsToPathString } from './util'

type ArrayMutationMethod =
  | 'push'
  | 'pop'
  | 'unshift'
  | 'shift'
  | 'splice'
  | 'sort'
  | 'reverse'
  | 'fill'

function clone<const T>(value: T): T {
  return klona(value)
}

export function useFormCore<
  const Schema extends FormSchema,
  const Data extends FormData<Schema> = FormData<Schema>,
>(formOpts: FormOptions<Schema>) {
  // console.debug('useFormCore()')
  const hooks = createHooks<FormHookDefinitions<Schema>>()
  if (formOpts.hooks) hooks.addHooks(formOpts.hooks)

  const sourceValues = computed(() => toValue(formOpts.sourceValues)) as ComputedRef<
    Data | undefined
  >
  const formUpdateCount = ref(0)
  const isDirty = computed(() => formUpdateCount.value !== 0)
  const isPending = ref(false)
  const isSubmitting = ref(false)
  const isLoading = computed(() => isSubmitting.value || isPending.value)
  const disabled = computed(() => isLoading.value)

  const formError = ref<StandardSchemaV1.FailureResult>()
  const formDataRef = ref(clone(sourceValues.value ?? {})) as Ref<Partial<Data>>
  const formData = toReactive(formDataRef) as Partial<Data>

  function reset() {
    console.debug('useForm: reset()')

    formDataRef.value = clone(sourceValues.value ?? {})
    formUpdateCount.value = 0
    formError.value = undefined
  }

  watch(
    sourceValues,
    () => {
      isPending.value = sourceValues.value === undefined
    },
    { immediate: true },
  )

  watch(sourceValues, () => {
    // allow updating source values during submit
    if (isDirty.value && !isSubmitting.value) {
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

  // $field can be undefined if the field was never accessed via $use() directly
  // e.g. only an array item was accessed -> 'array.$field' is never set
  type FieldCacheMeta = { $field: FormField<unknown, any> | undefined }
  const fieldCache: Record<string, FieldCacheMeta | undefined> = {}

  const fieldsCache = new Map<string, ComputedRef<BuildFormFieldAccessors<any>[]>>()

  const observedFormData = onChange(
    formData,
    (path, _value, _previousValue, _applyData) => {
      formUpdateCount.value++

      const cachedField = getProperty(fieldCache, pathSegmentsToPathString(path), undefined)
      void cachedField?.$field?.validate()
    },
    {
      ignoreDetached: true,
      ignoreSymbols: true,
      ignoreKeys: ['__v_raw'],
      pathAsArray: true,
      onValidate(path_, _value, _previousValue, applyData) {
        const path = path_ as unknown as string[] // pathAsArray: true

        const cachedField = getProperty(fieldCache, pathSegmentsToPathString(path), undefined)
        // @ts-expect-error $fetch is a property on the array object
        if (!cachedField || !isArray<(FieldCacheMeta | undefined)[]>(cachedField)) return true

        // console.debug('observedFormData', { path, value, prevValue, applyData })

        // keep fieldCache array structure & order in sync with data to prevent wrong item cache access
        match(applyData as { name: ArrayMutationMethod; args: unknown[] } | undefined)
          .with({ name: P.union('pop', 'shift', 'reverse') }, ({ name, args }) => {
            // @ts-expect-error args can be spread
            cachedField[name]?.(...args)
          })
          .with({ name: 'splice' }, ({ args }) => {
            const [start, deleteCount, ...items] = args as Parameters<[]['splice']>
            cachedField.splice(start, deleteCount, ...items.map(() => undefined))
          })
          .with({ name: 'unshift' }, () => {
            cachedField.unshift(undefined)
          })
          .with({ name: 'fill' }, ({ args: [_, ...args] }) => {
            cachedField.fill(undefined, ...(args as (number | undefined)[]))
          })
          .with({ name: 'sort' }, ({ args }) => {
            // setProperty(formData, path, prevValue) // onValidate runs before changes are applied
            const formDataField = getProperty(
              formData,
              pathSegmentsToPathString(path),
              [],
            ) as unknown[]

            const [compareFn] = args as Parameters<Array<unknown>['sort']>
            if (!compareFn) {
              cachedField.sort()
              formDataField.sort()
              return
            }

            cachedField.sort((a, b) => compareFn(a?.$field?.api.value, b?.$field?.api.value))
            formDataField.sort(compareFn)
          })
          .with({ name: P.union('push') }, () => {}) // noop
          .with(undefined, () => {
            // property update
            deleteProperty(fieldCache, pathSegmentsToPathString(path))
            // console.debug('fieldCache invalidate', path)
          })
          .exhaustive()

        return true
      },
    },
  )

  function createFormFieldProxy(path = '') {
    // console.debug('createFormFieldProxy():', path)
    return new Proxy(Object.create(null) as BuildFormFieldAccessors<Data, false, true>, {
      ownKeys() {
        const fieldValue = getProperty(formData, path, undefined)
        // console.debug('ownKeys():', path, fieldValue)
        return fieldValue ? Object.keys(fieldValue) : []
      },
      getOwnPropertyDescriptor(_target, _key) {
        return { enumerable: true, configurable: true, writable: false }
      },
      get(_target, prop: string | symbol) {
        if (prop === Symbol.iterator) {
          const fieldValue = computed(() => getProperty(formData, path, []) as unknown[] | null)
          if (fieldValue.value === null) return () => [].values()
          if (!Array.isArray(fieldValue.value)) return

          const iteratorPath = `${path}[Symbol.iterator]`
          // console.debug(iteratorPath)

          let fields = fieldsCache.get(iteratorPath)
          if (!fields) {
            const _fields = computed(
              () =>
                fieldValue.value?.map((_, index) => createFormFieldProxy(`${path}[${index}]`)) ??
                [],
            )
            fieldsCache.set(iteratorPath, _fields)
            fields = _fields
          }

          const iterator = computed(() => fields.value.values())

          return () => iterator.value
        }

        if (typeof prop === 'symbol') return

        if (prop === 'at') {
          return (_index: number) => {
            const fieldValue = getProperty(formData, path, []) as unknown[] | null
            if (!fieldValue || fieldValue.length === 0) return

            const { length } = fieldValue
            const index = _index < 0 ? (_index % length) + length : _index
            return createFormFieldProxy(`${path}[${index}]`)
          }
        }

        if (prop === 'delete') {
          return (key: string) => {
            const fieldValue = getProperty(formData, path, []) as unknown[] | null
            if (!fieldValue) throw new Error("Can't delete item when field is null")

            const keyPath = key.match(/(.*)@\d+$/)?.[1]
            if (!keyPath) throw new Error('Invalid key')
            if (!keyPath.startsWith(path)) throw new Error('Key does not reference an array item')

            const index = keyPath.match(/\[(\d+)\]$/)?.[1]
            fieldValue.splice(Number(index), 1)
          }
        }

        if (prop === '$use') {
          return <T>($opts: FormFieldAccessorOptions<T>) => {
            let field: FormField<unknown, any>

            const cachedField = getProperty(fieldCache, `${path}.$field`, undefined)
            if (cachedField) {
              field = cachedField
            } else {
              console.debug('$use', path)

              field = new FormField(path, {
                hooks,
                disabled,
                updateCount: formUpdateCount,
                data: formData,
                opts: formOpts,
                error: formError,
                sourceValues,
                isLoading,
                isPending,
              })

              Object.defineProperty(field.api, '$', {
                get() {
                  return () => createFormFieldProxy(field.api.path)
                },
              })

              Object.assign(field.api, formOpts[extend]?.setup?.(field.api))
              Object.assign(field.api, formOpts[extend]?.$use?.(field.api))

              setProperty(fieldCache, `${path}.$field`, field)
            }

            const discriminator = $opts?.discriminator
            if (discriminator) {
              return reactive({
                [discriminator]: computed(
                  () =>
                    (field.api.value as Record<string, unknown> | null)?.[discriminator] ?? null,
                ),
                $field: computed(() => createFormFieldProxy(field.api.path)),
              })
            }

            if (cachedField) {
              field.api[setContext]({ path })
            }

            if ($opts?.translate) return field.translatedApi($opts.translate)
            return field.api
          }
        }

        if (prop === '__v_raw') return

        const propPath = path ? `${path}.${escapePathSegment(prop)}` : escapePathSegment(prop)
        return createFormFieldProxy(propPath)
      },
    })
  }

  async function validateForm() {
    await hooks.callHook('beforeValidate')
    const result = await Promise.resolve(formOpts.schema['~standard'].validate(formData))
    await hooks.callHook('afterValidate', result as StandardSchemaV1.Result<Schema>)

    if (!result.issues) {
      formError.value = undefined
      return result.value
    }

    formError.value = result
  }

  return {
    hooks: hooks as FormHooks<FormHookDefinitions<Schema>>,
    fields: createFormFieldProxy(),
    isDirty,
    isChanged: computed(() => !hasSubObject<object, object>(sourceValues.value ?? {}, formData)),
    isLoading,
    data: observedFormData,
    errors: computed(() =>
      formError.value?.issues && hasAtLeast(formError.value.issues, 1)
        ? formError.value.issues
        : undefined,
    ),
    reset,
    submit: async () => {
      await hooks.callHook('beforeSubmit', { data: observedFormData })
      isSubmitting.value = true

      try {
        const validationResult = await validateForm()

        if (!validationResult) {
          isSubmitting.value = false
          return { success: false }
        }

        const ctx = { values: validationResult }
        const submitResult = (await formOpts.submit(ctx)) ?? { success: true }

        // don't reset because we don't want to overwrite the form data with the old sourceValues (updates to sourceValues are handled by the watcher)
        // only set formUpdateCount to 0 to mark the form as pristine
        if (submitResult.success) formUpdateCount.value = 0

        isSubmitting.value = false
        await hooks.callHook('afterSubmit', submitResult)

        return submitResult
      } catch (err) {
        console.error(err)
        isSubmitting.value = false

        const result = { success: false }
        await hooks.callHook('afterSubmit', result)

        return result
      }
    },
  } as const satisfies FormHandle & { fields: any; data: any }
}
