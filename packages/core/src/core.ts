import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { ComputedRef, DeepReadonly, Reactive, Ref } from '@vue/reactivity'
import type {
  IsAny,
  IsStringLiteral,
  IsSymbolLiteral,
  IsTuple,
  IsUnknown,
  PickIndexSignature,
  Simplify,
  Writable,
} from 'type-fest'
import type { IsUnion } from 'type-fest/source/internal'
import type { ZodArray, ZodObject, ZodType } from 'zod/v4'
import { computed, reactive, readonly, ref, shallowReactive, toRef, watch } from '@vue/reactivity'
import { deleteProperty, getProperty, setProperty } from 'dot-prop'
import { klona } from 'klona/full'
import onChange from 'on-change'
import { hasSubObject, isArray, isDeepEqual } from 'remeda'
import { match, P } from 'ts-pattern'
import { issuePathToDotNotation } from './helpers'
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

type ObjectHasFunctionsOrSymbols<T> =
  IsAny<T[keyof T]> extends true
    ? false
    : IsUnknown<T[keyof T]> extends true
      ? false
      : [(...args: any[]) => any] extends [NonNullable<T>[keyof NonNullable<T>]]
        ? true
        : true extends { [K in keyof T]: IsSymbolLiteral<K> extends true ? true : never }[keyof T]
          ? true
          : false

export type NullableDeep<T> =
  GetDiscriminator<T> extends infer Discriminator
    ? T extends object
      ? T extends any[]
        ? NullableDeep<T[number]>[] | null
        : ObjectHasFunctionsOrSymbols<T> extends true
          ? T | null
          :
              | Simplify<{
                  [K in keyof T]: K extends Discriminator ? T[K] : NullableDeep<T[K]>
                }>
              | (keyof PickIndexSignature<T> extends never ? null : never)
      : T | null
    : never

export type FormSchema = StandardSchemaV1
type FormData<Schema extends FormSchema> = NonNullable<
  NullableDeep<StandardSchemaV1.InferOutput<Schema>>
>

export const extendsSymbol = Symbol('extends')

type MaybeGetter<T extends object> = T | (() => T)

export interface FormOptions<
  Schema extends FormSchema,
  Output extends StandardSchemaV1.InferOutput<Schema> = StandardSchemaV1.InferOutput<Schema>,
> {
  schema: Schema
  sourceValues: MaybeGetter<Writable<FormData<Schema>>>
  submit: (ctx: { values: Output }) => Promise<void | { success: boolean }>

  [extendsSymbol]?: {
    $use?: <T>(field: FormFieldInternal<T>) => Omit<FormField<T>, keyof typeof field>
  }
}

const updatePathSymbol = Symbol('updatePath')

interface FormFieldInternal<T> {
  errors: Ref<string[] | undefined>
  value: Readonly<Ref<T>>
  handleChange: (value: T) => void
  handleBlur: () => void
  reset: () => void
  disabled: ComputedRef<boolean>
  isDirty: ComputedRef<boolean>
  isChanged: ComputedRef<boolean>
  path: string
  key: string
  validator: ZodType | undefined
  $?: () => BuildFormFieldAccessors<any>
  [updatePathSymbol]: (newPath: string) => void
}

export interface FormField<T> extends Omit<FormFieldInternal<T>, '$'> {
  $: <TT extends T>() => BuildFormFieldAccessors<TT>
}
export type FormFieldProps<T> = { field: FormField<NullableDeep<T>> }

function clone<const T>(value: T): T {
  return klona(value)
}

export function useFormCore<
  const Schema extends FormSchema,
  const Data extends FormData<Schema> = FormData<Schema>,
>(formOpts: FormOptions<Schema>) {
  // console.debug('useFormCore()')

  const sourceValues = toRef(formOpts.sourceValues) as unknown as Ref<Data>
  const formUpdateCount = ref(0)
  const isSubmitting = ref(false)
  const disabled = computed(() => isSubmitting.value)

  const formError = ref<StandardSchemaV1.FailureResult>()
  const formDataRef = ref(clone(sourceValues.value)) as Ref<Data>
  const formData = toReactive(formDataRef) as Data

  function reset() {
    // console.debug('useCoolForm: reset()')

    formDataRef.value = clone(sourceValues.value)
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

  type FieldCacheMeta = { $field: FormFieldInternal<unknown> }
  const fieldCache: Record<string, FieldCacheMeta | undefined> = {}

  const fieldsCache = new Map<string, ComputedRef<BuildFormFieldAccessors<any>[]>>()

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
          return <T extends DeepReadonly<any>>(
            $opts: Parameters<FormFieldAccessor<T>['$use']>[0] &
              Parameters<FormFieldAccessorDiscriminator<T, string>['$use']>[0],
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

            const discriminator = $opts?.discriminator
            if (discriminator) {
              return reactive({
                // eslint-disable-next-line ts/no-unsafe-return, ts/no-unsafe-member-access
                [discriminator]: computed(() => fieldValue.value[discriminator]),
                $field: computed(() => createFormFieldProxy(pathRef.value)),
              })
            }

            const updateCount = ref(0)
            watch(formUpdateCount, () => {
              if (formUpdateCount.value === 0) updateCount.value = 0
            })

            const fieldValidator = getValidatorByPath(
              formOpts.schema as unknown as ZodType,

              path.replaceAll(/\[(\d+)\]/g, '.$1').split('.'),
            )

            const initialValue = computed<unknown>(() =>
              getProperty(sourceValues.value, path, undefined),
            )
            const fieldError = ref<StandardSchemaV1.FailureResult>()
            watch(formError, () => {
              fieldError.value = formError.value
                ? ({
                    issues: formError.value.issues.filter((issue) => {
                      if (!issue.path) return false
                      const issuePath = issuePathToDotNotation(issue.path)
                      return issuePath === pathRef.value
                    }),
                  } satisfies StandardSchemaV1.FailureResult)
                : undefined
            })
            const fieldErrors = refEffect(() =>
              fieldError.value && fieldError.value.issues.length > 0
                ? fieldError.value.issues.map((i) => i.message)
                : undefined,
            )
            watch(isSubmitting, () => {
              if (isSubmitting.value) fieldErrors.reset()
            })

            async function validateField() {
              const formResult = await Promise.resolve(
                formOpts.schema['~standard'].validate(formData),
              )
              if (!formResult.issues) {
                fieldError.value = undefined
                return
              }

              fieldError.value = {
                issues: formResult.issues.filter((issue) => {
                  if (!issue.path) return false
                  const issuePath = issuePathToDotNotation(issue.path)
                  return issuePath === pathRef.value
                }),
              } satisfies StandardSchemaV1.FailureResult
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

                if (fieldErrors.value && fieldErrors.value.length > 0) void validateField()
              },
              handleBlur: () => {
                // console.debug(`======== handleBlur (${pathRef.value})`)
                if (updateCount.value === 0) return

                void validateField()
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
            } satisfies FormFieldInternal<T>)

            Object.defineProperty(field, '$', {
              get() {
                return () => createFormFieldProxy(path)
              },
            })

            function updatePath(newPath: string) {
              pathRef.value = newPath
              field.path = newPath
            }

            Object.assign(field, formOpts[extendsSymbol]?.$use?.(field))

            setProperty(fieldCache, `${path}.$field`, field)
            return field
          }
        }

        if (prop === '__v_raw') return

        const propPath = path ? `${path}.${prop}` : prop
        return createFormFieldProxy(propPath)
      },
    })
  }

  async function validateForm() {
    const result = await Promise.resolve(formOpts.schema['~standard'].validate(formData))
    if (!result.issues) {
      formError.value = undefined
      return result.value
    }

    formError.value = result
  }

  return {
    fields: createFormFieldProxy(),
    isDirty: computed(() => formUpdateCount.value !== 0),
    isChanged: computed(() => !hasSubObject<object, object>(sourceValues.value, formData)),
    isSubmitting: readonly(isSubmitting),
    data: observedFormData,
    errors: computed(() => formError.value?.issues),
    reset,
    submit: async () => {
      isSubmitting.value = true

      try {
        const validationResult = await validateForm()

        if (!validationResult) {
          isSubmitting.value = false
          return { success: false }
        }

        const submitResult = await formOpts.submit({ values: validationResult })
        // undefined submitResult is successful
        if ((submitResult ?? {}).success === false) {
          return { success: false }
        }

        formUpdateCount.value = 0

        return { success: true }
      } catch (err) {
        console.error(err)
        return { success: false }
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
type FormFieldAccessor<T> = {
  $use: (opts?: { translate?: FormFieldTranslator<T> }) => FormField<T>
}

type FormFieldAccessorDiscriminator<T, Discriminator extends string> = {
  $use: <
    Opts extends {
      discriminator?: Discriminator
    },
  >(
    opts?: Opts,
  ) => Opts extends { discriminator: string }
    ? {
        [D in T[Extract<keyof T, Discriminator>] & string]: Simplify<
          Record<Discriminator, D> & {
            $field: BuildFormFieldAccessors<Extract<T, Record<Discriminator, D>>, true>
          }
        >
      }[T[Extract<keyof T, Discriminator>] & string]
    : FormField<T>
}

export const ErrorMessageSymbol: unique symbol = Symbol('ErrorMessageSymbol')
// type Error<M> = { [ErrorMessageSymbol]: M }

// const _schema = z.object({ list: z.array(z.object({ name: z.string() })) })
// type TestTestTestTestTestTestTestTestTestTest = BuildFormFieldAccessors<FormData<typeof _schema>>
// const asdasdas = {} as TestTestTestTestTestTestTestTestTestTest

// const _asdasd = asdasdas.list.$use().value.value
// const _asdasd2 = asdasdas.list.at(0)!.$use().value.value?.name

type GetDiscriminator<T> =
  IsUnion<T> extends true
    ? { [K in keyof T as IsStringLiteral<T[K]> extends true ? K : never]: T[K] } extends Record<
        infer D,
        any
      >
      ? D
      : never
    : never

export type FormFields<T> = BuildFormFieldAccessors<NullableDeep<T>>

type BuildFormFieldAccessors<T, StopDiscriminator = false> = [IsAny<T>] extends [true]
  ? FormFieldAccessor<any>
  : [T] extends [(infer TT extends unknown[]) | null]
    ? {
        at: <const I extends number>(
          index: I,
        ) => [undefined] extends [TT[I]]
          ? undefined
          : BuildFormFieldAccessors<TT[I]> | (IsTuple<TT> extends true ? never : undefined)
        delete: (key: string) => void
        [Symbol.iterator]: () => ArrayIterator<
          Reactive<BuildFormFieldAccessors<NonNullable<TT>[number]>>
        >
      } & FormFieldAccessor<T>
    : [NonNullable<T>] extends [Record<string, unknown>]
      ? ObjectHasFunctionsOrSymbols<T> extends true
        ? FormFieldAccessor<T>
        : GetDiscriminator<NonNullable<T>> extends (StopDiscriminator extends true ? any : never)
          ? FormFieldAccessor<T> & {
              [K in keyof NonNullable<T>]: BuildFormFieldAccessors<NonNullable<T>[K]>
            }
          : GetDiscriminator<NonNullable<T>> extends infer Discriminator extends string
            ? NonNullable<T> extends Record<Discriminator, infer Options extends string>
              ? {
                  [O in Options]: BuildFormFieldAccessors<
                    Extract<NonNullable<T>, Record<Discriminator, O>>
                  >
                }[Options] &
                  FormFieldAccessorDiscriminator<NonNullable<T>, Discriminator>
              : never
            : never
      : FormFieldAccessor<T>

// type TEST = BuildFormFieldAccessors<ZodObject['_zod']['output']>

function getValidatorByPath(validator: ZodType, path: string[]) {
  // console.debug('getValidatorByPath', validator, path)
  if (path.length === 0) return validator

  const [key, ...rest] = path as [string, ...string[]]

  let nextValidator: ZodType | undefined

  if ('shape' in validator) {
    // eslint-disable-next-line ts/no-unsafe-assignment
    nextValidator = (validator as ZodObject).shape[key]
  }
  if ('element' in validator) {
    nextValidator = (validator as ZodArray<ZodType>).element
  }

  if (rest.length === 0 || !nextValidator) {
    return nextValidator
  }

  return getValidatorByPath(nextValidator, rest)
}
