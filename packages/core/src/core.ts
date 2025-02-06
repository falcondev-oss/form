import type { IsAny, Simplify, WritableDeep } from 'type-fest'
import type {
  AnyZodObject,
  AnyZodTuple,
  SomeZodObject,
  z,
  ZodArray,
  ZodEffects,
  ZodError,
  ZodFormattedError,
  ZodNullable,
  ZodRecord,
  ZodTypeAny,
} from 'zod'
import {
  computed,
  type ComputedRef,
  type DeepReadonly,
  type MaybeRefOrGetter,
  type Reactive,
  readonly,
  type Ref,
  ref,
  shallowReactive,
  toRef,
  watch,
} from '@vue/reactivity'
import { deleteProperty, getProperty, setProperty } from 'dot-prop'
import { klona } from 'klona/full'
import onChange from 'on-change'
import { isArray, isDeepEqual } from 'remeda'
import { match, P } from 'ts-pattern'

import { refEffect, toReactive } from './reactive'

type ArrayMutationMethod =
  | 'push'
  | 'pop'
  | 'unshift'
  | 'shift'
  | 'splice'
  | 'sort'
  | 'reverse'
  | 'fill'

type ObjectHasFunctions<T> =
  IsAny<T[keyof T]> extends true
    ? false
    : [(...args: any[]) => any] extends [T[keyof T]]
      ? true
      : false

export type NullableLeaf<T> =
  IsAny<T> extends true
    ? any
    : {
        [K in keyof T]: T[K] extends any[]
          ? NullableLeaf<T[K]> | null
          : T[K] extends object
            ? [ObjectHasFunctions<T[K]>] extends [true]
              ? T[K] | null
              : Simplify<NullableLeaf<T[K]>>
            : T[K] | null
      }

// type NullableLeafRootAcc<T extends object, Acc = object> = [ObjectHasFunctions<T>] extends [true]
//   ? never
//   : Simplify<{
//       [K in keyof T]: NullableLeafWorker<T[K], Acc>
//     }>

// // Worker type that processes one level at a time
// type NullableLeafWorker<T, Acc> = T extends Acc[keyof Acc]
//   ? Acc[keyof Acc]
//   : NullableLeafAcc<T, Acc & { [K in keyof Acc | typeof Symbol.iterator]: T }>

// // Accumulator type to store intermediate results
// type NullableLeafAcc<T, Acc = object> = T extends any[]
//   ? NullableLeafWorker<T[number], Acc>[] | null
//   : T extends object
//     ? [ObjectHasFunctions<T>] extends [true]
//       ? T | null
//       : Simplify<{
//           [K in keyof T]: NullableLeafWorker<T[K], Acc>
//         }>
//     : T | null

// // Main type that initiates the transformation
// type NullableLeaf<T extends object> = NullableLeafRootAcc<T>

export type FormSchema = SomeZodObject
type FormValues<Schema extends FormSchema> = NullableLeaf<z.infer<Schema>>

export const extendsSymbol = Symbol('extends')

export interface FormOptions<
  Schema extends FormSchema,
  Output extends z.infer<Schema> = z.infer<Schema>,
> {
  schema: Schema
  sourceValues: MaybeRefOrGetter<WritableDeep<NullableLeaf<Output>>>
  submit: (ctx: { values: Output }) => Promise<void>

  [extendsSymbol]?: {
    $use?: <T>(
      field: FormFieldInternal<T, ZodTypeAny>,
    ) => Omit<FormField<T, ZodTypeAny>, keyof typeof field>
  }
}

const updatePathSymbol = Symbol('updatePath')

interface FormFieldInternal<T, V extends ZodTypeAny> {
  errors: Ref<string[]>
  value: Readonly<Ref<T>>
  handleChange: (value: T) => void
  handleBlur: () => void
  reset: () => void
  disabled: ComputedRef<boolean>
  isDirty: ComputedRef<boolean>
  isChanged: ComputedRef<boolean>
  path: string
  key: string
  validator: V
  [updatePathSymbol]: (newPath: string) => void
}

export interface FormField<T, V extends ZodTypeAny> extends FormFieldInternal<T, V> {}
export type FormFieldProps<T> = { field: FormField<T, ZodTypeAny> }

function clone<const T>(value: T): T {
  return klona(value)
}

export function useFormCore<
  const Schema extends FormSchema,
  Data extends FormValues<Schema> = FormValues<Schema>,
>(formOpts: FormOptions<Schema>) {
  // console.debug('useFormCore()')

  const sourceValues = toRef(formOpts.sourceValues) as Ref<Data>
  const formUpdateCount = ref(0)
  const isSubmitting = ref(false)
  const disabled = computed(() => isSubmitting.value)

  const formError = ref<ZodError>()
  const _formDataRef = ref(clone(sourceValues.value)) as Ref<Data>
  const formData = toReactive(_formDataRef) as Data

  function reset() {
    // console.debug('useCoolForm: reset()')

    _formDataRef.value = clone(sourceValues.value)
    formUpdateCount.value = 0
    formError.value = undefined
  }

  watch(sourceValues, () => {
    // console.debug('sourceValues changed')
    if (formUpdateCount.value !== 0) {
      /* TODO: update all untouched fields & show info on outdated fields.
        form.sourceValues + sourceValues.timestamp

        field.isTouched.timestamp > sourceValues.timestamp: field was changed normally (option: undo)
        field.isTouched.timestamp < sourceValues.timestamp: field is outdated (option: update)
      */
      console.warn('useCoolForm:', 'Skipped sourceValues update after form was edited.')
      return
    }
    reset()
  })

  type FieldCacheMeta = { $field: FormFieldInternal<unknown, ZodTypeAny> }
  const fieldCache: Record<string, FieldCacheMeta | undefined> = {}

  const fieldsCache = new Map<string, ComputedRef<BuildFormFieldAccessors<unknown, ZodTypeAny>[]>>()

  const observedFormData = onChange(
    formData,
    (path, value, prevValue, applyData) => {
      formUpdateCount.value++

      const cachedField = getProperty(fieldCache, path, undefined)
      // @ts-expect-error $fetch is a key of the array
      if (!cachedField || !isArray<(FieldCacheMeta | undefined)[]>(cachedField)) return

      // console.debug('observedFormData', { path, value, prevValue, applyData })

      match(applyData as { name: ArrayMutationMethod; args: unknown[] } | undefined)
        .with({ name: P.union('pop', 'splice', 'shift', 'reverse') }, ({ name, args }) => {
          // @ts-expect-error args can be spread
          cachedField[name]?.(...args)
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

          cachedField.sort((a, b) => compareFn(a?.$field.value.value, b?.$field.value.value))
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
    return new Proxy(Object.create(null) as FormFields<Schema>, {
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
                fieldValue.value?.map(
                  (_, index) =>
                    createFormFieldProxy(`${path}[${index}]`) as BuildFormFieldAccessors<
                      unknown,
                      ZodTypeAny
                    >,
                ) ?? [],
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
          return <T extends DeepReadonly<any>>(
            $opts: Parameters<FormFieldAccessor<T, ZodTypeAny>['$use']>[0],
          ) => {
            const cachedField = getProperty(fieldCache, `${path}.$field`, undefined)
            if (cachedField) {
              cachedField[updatePathSymbol](path)
              return cachedField
            }

            const pathRef = ref(path)
            // console.debug('$use', path)

            const isEditing = ref(false)
            function getValue() {
              const _value = getProperty(formData, pathRef.value, undefined) as T
              return $opts?.translate?.get(_value) ?? _value
            }
            const fieldValue = ref(getValue())
            watch(
              () => getValue(),
              () => {
                // console.debug(`======== fieldValue (${pathRef.value})`)
                if (isEditing.value) return

                fieldValue.value = getValue()
              },
            )

            const updateCount = ref(0)
            watch(formUpdateCount, () => {
              if (formUpdateCount.value === 0) updateCount.value = 0
            })

            const fieldValidator = getValidatorByPath(
              formOpts.schema,

              path.replaceAll(/\[(\d+)\]/g, '.$1').split('.'),
            )
            if (!fieldValidator) throw new Error(`Missing validator: ${path}`)

            const initialValue = computed<unknown>(() =>
              getProperty(sourceValues.value, path, undefined),
            )
            const fieldError = ref<ZodFormattedError<unknown>>()
            watch(formError, () => {
              fieldError.value = getProperty(
                formError.value?.format(),
                pathRef.value,
                undefined,
              ) as ZodFormattedError<unknown> | undefined
            })
            const fieldErrors = refEffect(() => fieldError.value?._errors ?? [])
            watch(isSubmitting, () => {
              if (isSubmitting.value) fieldErrors.reset()
            })

            function validateField() {
              if (!fieldValidator) throw new Error(`Missing validator: ${path}`)

              const result = fieldValidator.safeParse(fieldValue.value)
              if (result?.success) {
                fieldError.value = undefined
                // eslint-disable-next-line ts/no-unsafe-return
                return result.data
              }

              fieldError.value = result.error.format()
            }

            const now = Date.now()
            const field = shallowReactive({
              disabled,
              errors: fieldErrors,
              handleChange: (_value: T) => {
                isEditing.value = true

                // console.debug(
                //   `======== handleChange (${pathRef.value}): '${JSON.stringify(_value)}'`,
                // )

                fieldValue.value = _value

                const value = $opts?.translate?.set(_value) ?? _value
                setProperty(formData, pathRef.value, value)
                isEditing.value = false

                updateCount.value++
                formUpdateCount.value++

                if (fieldErrors.value.length > 0) validateField()
              },
              handleBlur: () => {
                // console.debug(`======== handleBlur (${pathRef.value})`)

                validateField()
              },
              reset: () => {
                updateCount.value = 0

                setProperty(formData, pathRef.value, initialValue.value)

                fieldError.value = undefined
              },
              isChanged: computed(
                () => !isDeepEqual<unknown>(fieldValue.value, initialValue.value),
              ),
              isDirty: computed(() => updateCount.value !== 0),
              value: readonly(fieldValue) as Ref<T>,
              path,
              key: `${path}@${now}`,
              validator: fieldValidator,
              [updatePathSymbol]: updatePath,
            } satisfies FormFieldInternal<T, ZodTypeAny>)

            function updatePath(newPath: string) {
              pathRef.value = newPath
              field.path = newPath
            }

            Object.assign(field, formOpts[extendsSymbol]?.$use?.(field))

            setProperty(fieldCache, `${path}.$field`, field)
            return field
          }
        }

        const currentPath = path ? `${path}.${prop}` : prop

        const propValidator = getValidatorByPath(
          formOpts.schema,

          currentPath.replaceAll(/\[(\d+)\]/g, '.$1').split('.'),
        )
        if (!propValidator) return

        return createFormFieldProxy(currentPath)
      },
    })
  }

  function validateForm() {
    const result = formOpts.schema.safeParse(formData)
    if (result.success) {
      formError.value = undefined
      return result.data as Data
    }

    formError.value = result.error
  }

  return {
    fields: createFormFieldProxy(),
    isDirty: computed(() => formUpdateCount.value !== 0),
    isChanged: computed(() => !isDeepEqual<unknown>(formData, sourceValues.value)),
    isSubmitting: readonly(isSubmitting),
    data: observedFormData,
    errors: computed(() => formError.value?.format()),
    reset,
    submit: async () => {
      isSubmitting.value = true

      try {
        const validationResult = validateForm()

        if (!validationResult) {
          isSubmitting.value = false
          return { success: false }
        }

        await formOpts.submit({ values: validationResult })
        formUpdateCount.value = 0

        return { success: true }
      } finally {
        isSubmitting.value = false
      }
    },
  }
}

export type FormFieldTranslator<T> = {
  get: (v: T) => T
  set: (v: T) => T
}
type FormFieldAccessor<T, V extends ZodTypeAny> = {
  $use: (opts?: { translate?: FormFieldTranslator<T> }) => FormField<T, V>
}

type FormFields<Schema extends FormSchema> = BuildFormFieldAccessors<FormValues<Schema>, Schema>

export const ErrorMessageSymbol: unique symbol = Symbol('ErrorMessageSymbol')
type Error<N> = { [ErrorMessageSymbol]: N }

type BuildFormFieldAccessors<T, V extends ZodTypeAny> = [IsAny<T>] extends [true]
  ? FormFieldAccessor<any, ZodTypeAny>
  : [T] extends [unknown[] | null]
    ? V extends ZodNullable<ZodTypeAny>
      ? BuildFormFieldAccessors<T, V['_def']['innerType']>
      : V extends ZodEffects<infer Output>
        ? BuildFormFieldAccessors<T, Output>
        : V extends ZodArray<ZodTypeAny>
          ? {
              at: (
                index: number,
              ) => BuildFormFieldAccessors<Exclude<T, null>[number], V['element']> | undefined
              delete: (key: string) => void
              [Symbol.iterator]: () => ArrayIterator<
                Reactive<BuildFormFieldAccessors<Exclude<T, null>[number], V['element']>>
              >
            } & FormFieldAccessor<T, V>
          : V extends AnyZodTuple
            ? {
                at: <const I extends number>(
                  index: I,
                ) => BuildFormFieldAccessors<Exclude<T, null>[I], V['items'][I]> | undefined
                delete: (key: string) => void
                [Symbol.iterator]: () => ArrayIterator<
                  Reactive<BuildFormFieldAccessors<Exclude<T, null>[number], V['items'][number]>>
                >
              } & FormFieldAccessor<T, V>
            : Error<'array validator type not supported'>
    : ObjectHasFunctions<T> extends true
      ? FormFieldAccessor<T, V>
      : [T] extends [Record<string, unknown>]
        ? V extends AnyZodObject
          ? {
              [K in keyof T]: BuildFormFieldAccessors<T[K], V['shape'][K]>
            } & FormFieldAccessor<T, V>
          : V extends ZodRecord<ZodTypeAny>
            ? {
                [K in keyof T]: BuildFormFieldAccessors<T[K], V['element']>
              } & FormFieldAccessor<T, V>
            : Error<'object validator type not supported'>
        : FormFieldAccessor<T, V>

function getValidatorByPath(validator: ZodTypeAny, path: string[]) {
  if (path.length === 0) return validator

  const [key, ...rest] = path as [string, ...string[]]

  let nextValidator: ZodTypeAny | undefined

  if ('shape' in validator) {
    // eslint-disable-next-line ts/no-unsafe-assignment, ts/no-unsafe-member-access
    nextValidator = (validator as AnyZodObject).shape[key]
  }
  if ('element' in validator) {
    nextValidator = (validator as ZodArray<ZodTypeAny>).element
  }

  if (rest.length === 0 || !nextValidator) {
    return nextValidator
  }

  return getValidatorByPath(nextValidator, rest)
}
