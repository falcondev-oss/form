import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { ComputedRef, Ref } from '@vue/reactivity'
import type {
  BuildFormFieldAccessors,
  FormData,
  FormFieldAccessorOptions,
  FormHooks,
  FormOptions,
  FormSchema,
} from './types'
import { computed, reactive, readonly, ref, toRef, watch } from '@vue/reactivity'
import { deleteProperty, getProperty, setProperty } from 'dot-prop'
import { createHooks } from 'hookable'
import { klona } from 'klona/full'
import onChange from 'on-change'
import { hasSubObject, isArray } from 'remeda'
import { match, P } from 'ts-pattern'
import { FormField } from './field'
import { toReactive } from './reactive'
import { contextSymbol, extendsSymbol } from './types'

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
  const hooks = createHooks<FormHooks<Schema>>()
  if (formOpts.hooks) hooks.addHooks(formOpts.hooks)

  const sourceValues = toRef(formOpts.sourceValues) as unknown as Ref<Data | undefined>
  const formUpdateCount = ref(0)
  const isLoading = ref(false)
  const disabled = computed(() => isLoading.value)

  const formError = ref<StandardSchemaV1.FailureResult>()
  const formDataRef = ref(clone(sourceValues.value ?? {})) as Ref<Partial<Data>>
  const formData = toReactive(formDataRef) as Partial<Data>

  function reset() {
    // console.debug('useCoolForm: reset()')

    formDataRef.value = clone(sourceValues.value ?? {})
    formUpdateCount.value = 0
    formError.value = undefined
  }

  watch(
    sourceValues,
    () => {
      isLoading.value = sourceValues.value === undefined
    },
    { immediate: true },
  )

  watch(sourceValues, () => {
    // console.debug('sourceValues changed')
    if (formUpdateCount.value !== 0) {
      /* TODO: update all untouched fields & show info on outdated fields.
        form.sourceValues + sourceValues.timestamp

        field.isTouched.timestamp > sourceValues.timestamp: field was changed normally (option: undo)
        field.isTouched.timestamp < sourceValues.timestamp: field is outdated (option: update)
      */
      console.warn('useForm:', 'Skipped sourceValues update after form was edited')
      return
    }
    if (isLoading.value) return
    reset()
  })

  type FieldCacheMeta = { $field: FormField<unknown, any> }
  const fieldCache: Record<string, FieldCacheMeta | undefined> = {}

  const fieldsCache = new Map<string, ComputedRef<BuildFormFieldAccessors<any>[]>>()

  const observedFormData = onChange(
    formData,
    (path, value, prevValue, applyData) => {
      formUpdateCount.value++

      const cachedField = getProperty(fieldCache, path, undefined)
      // @ts-expect-error $fetch is a property on the array object
      if (!cachedField || !isArray<(FieldCacheMeta | undefined)[]>(cachedField)) return

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
          setProperty(formData, path, prevValue)
          const formDataField = getProperty(formData, path, []) as unknown[]

          const [compareFn] = args as Parameters<Array<unknown>['sort']>
          if (!compareFn) {
            cachedField.sort()
            formDataField.sort()
            return
          }

          cachedField.sort((a, b) => compareFn(a?.$field.api.value, b?.$field.api.value))
          formDataField.sort(compareFn)
        })
        .with({ name: P.union('push') }, () => {}) // noop
        .with(undefined, () => {
          // property update
          deleteProperty(fieldCache, path)
          // console.debug('fieldCache invalidate', path)
        })
        .exhaustive()
    },
    {
      ignoreDetached: true,
      ignoreSymbols: true,
      ignoreKeys: ['__v_raw'],
    },
  )

  function createFormFieldProxy(path = '') {
    // console.debug('createFormFieldProxy():', path)
    return new Proxy(Object.create(null) as BuildFormFieldAccessors<Data>, {
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
              })

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
              field.api[contextSymbol]({ path })
            } else {
              Object.defineProperty(field.api, '$', {
                get() {
                  return () => createFormFieldProxy(path)
                },
              })

              Object.assign(field.api, formOpts[extendsSymbol]?.$use?.(field.api))
            }

            if ($opts?.translate) return field.translatedApi($opts.translate)
            return field.api
          }
        }

        if (prop === '__v_raw') return

        const propPath = path ? `${path}.${prop}` : prop
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
    hooks,
    fields: createFormFieldProxy(),
    isDirty: computed(() => formUpdateCount.value !== 0),
    isChanged: computed(() => !hasSubObject<object, object>(sourceValues.value ?? {}, formData)),
    isLoading: readonly(isLoading),
    data: observedFormData,
    errors: computed(() => formError.value?.issues),
    reset,
    submit: async () => {
      isLoading.value = true

      try {
        const validationResult = await validateForm()

        if (!validationResult) {
          isLoading.value = false
          return { success: false }
        }

        const ctx = { values: validationResult }
        await hooks.callHook('beforeSubmit', ctx)
        const submitResult = (await formOpts.submit(ctx)) ?? { success: true }
        await hooks.callHook('afterSubmit', submitResult)

        if (submitResult.success) formUpdateCount.value = 0

        return submitResult
      } catch (err) {
        console.error(err)
        return { success: false }
      } finally {
        isLoading.value = false
      }
    },
  } as const
}
