import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { ComputedRef, Reactive, Ref } from '@vue/reactivity'
import type { NestedHooks } from 'hookable'
import type {
  IfUnknown,
  IsAny,
  IsStringLiteral,
  IsSymbolLiteral,
  IsTuple,
  IsUnknown,
  PickIndexSignature,
  Primitive,
  Simplify,
  Writable,
} from 'type-fest'
import type { IsUnion } from 'type-fest/source/internal'
import type { ZodArray, ZodObject, ZodType } from 'zod/v4'
import { computed, markRaw, reactive, readonly, ref, toRef, watch } from '@vue/reactivity'
import { deleteProperty, getProperty, setProperty } from 'dot-prop'
import { createHooks } from 'hookable'
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
      : [NonNullable<T>[keyof NonNullable<T>]] extends [(...args: any[]) => any]
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

type MaybeGetter<T extends object | undefined> = T | (() => T)

export interface FormOptions<
  Schema extends FormSchema,
  Output extends StandardSchemaV1.InferOutput<Schema> = StandardSchemaV1.InferOutput<Schema>,
> {
  schema: Schema
  sourceValues: MaybeGetter<Writable<FormData<Schema>> | undefined>
  submit: (ctx: { values: Output }) => Promise<void | { success: boolean }>
  hooks?: NestedHooks<FormHooks<Schema>>
  [extendsSymbol]?: {
    $use?: <T>(field: FormFieldInternal<T>) => FormFieldExtend<T>
  }
}

export interface FormHooks<
  Schema extends FormSchema,
  Output extends StandardSchemaV1.InferOutput<Schema> = StandardSchemaV1.InferOutput<Schema>,
> {
  beforeSubmit: (ctx: { values: Output }) => Promise<void> | void
  afterSubmit: (result: { success: boolean }) => Promise<void> | void
  // beforeReset: () => Promise<void> | void
  // afterReset: () => Promise<void> | void
  beforeValidate: () => Promise<void> | void
  afterValidate: (result: StandardSchemaV1.Result<Schema>) => Promise<void> | void
  // beforeFieldReset: () => Promise<void> | void
  // afterFieldReset: () => Promise<void> | void
  beforeFieldChange: (field: FormFieldInternal<unknown>, newValue: unknown | null) => void
  afterFieldChange: (field: FormFieldInternal<unknown>, updatedValue: unknown | null) => void
}

const contextSymbol = Symbol('contextSymbol')

export type NonPrimitiveReadonly<T> = T extends Primitive ? T : Readonly<T>
export type FormFieldInternal<T> = {
  errors: string[] | undefined
  value: NonPrimitiveReadonly<T>
  handleChange: (value: T) => void
  handleBlur: () => void
  reset: () => void
  disabled: boolean
  isDirty: boolean
  isChanged: boolean
  path: string
  key: string
  validator: ZodType | undefined
  $?: () => BuildFormFieldAccessors<any>
  [contextSymbol]: (ctx: { path: string }) => void
}

// eslint-disable-next-line unused-imports/no-unused-vars
export interface FormFieldExtend<T> {}

export interface FormField<T>
  extends Omit<FormFieldInternal<T>, '$'>,
    Reactive<FormFieldExtend<T>> {
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

  type FieldCacheMeta = { $field: FormFieldInternal<unknown> }
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

          cachedField.sort((a, b) => compareFn(a?.$field.value, b?.$field.value))
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
            const cachedField = getProperty(fieldCache, `${path}.$field`, undefined)
            if (cachedField && !$opts?.discriminator) {
              cachedField[contextSymbol]({ path })
              return cachedField
            }

            const context = ref<Parameters<FormFieldInternal<T>[typeof contextSymbol]>[0]>({
              path,
            })
            // console.debug('$use', path)

            const isEditing = ref(false)
            function getValue() {
              const _value = getProperty(formData, context.value.path, null) as T
              return $opts?.translate?.get(_value) ?? _value
            }
            const fieldValue = ref<unknown | null>(getValue())
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
                [discriminator]: computed(
                  () =>
                    (fieldValue.value as Record<string, unknown> | null)?.[discriminator] ?? null,
                ),
                $field: computed(() => createFormFieldProxy(context.value.path)),
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
                      return issuePath === context.value.path
                    }),
                  } satisfies StandardSchemaV1.FailureResult)
                : undefined
            })
            const fieldErrors = refEffect(() =>
              fieldError.value && fieldError.value.issues.length > 0
                ? fieldError.value.issues.map((i) => i.message)
                : undefined,
            )
            watch(isLoading, () => {
              if (isLoading.value) fieldErrors.reset()
            })

            async function validateField() {
              const formResult = await Promise.resolve(
                formOpts.schema['~standard'].validate(formData),
              )
              if (!formResult.issues) {
                fieldError.value = undefined
                fieldErrors.reset()
                return
              }

              fieldError.value = {
                issues: formResult.issues.filter((issue) => {
                  if (!issue.path) return false
                  const issuePath = issuePathToDotNotation(issue.path)
                  return issuePath === context.value.path
                }),
              } satisfies StandardSchemaV1.FailureResult
            }

            const now = Date.now()
            const field = reactive({
              disabled,
              errors: fieldErrors,
              handleChange: (_value: T) => {
                if (disabled.value) {
                  console.warn(
                    'useForm:',
                    'handleChange() was blocked on a disabled field',
                    `(${context.value.path})`,
                  )
                  return
                }

                isEditing.value = true

                // console.debug(
                //   `======== handleChange (${pathRef.value}): '${JSON.stringify(_value)}'`,
                // )
                void hooks.callHook(
                  'beforeFieldChange',
                  field as FormFieldInternal<unknown>,
                  _value,
                )

                fieldValue.value = _value

                const value = $opts?.translate?.set(_value) ?? _value
                setProperty(formData, context.value.path, value)
                isEditing.value = false

                updateCount.value++
                formUpdateCount.value++

                void hooks.callHook('afterFieldChange', field as FormFieldInternal<unknown>, value)

                if (fieldErrors.value && fieldErrors.value.length > 0) void validateField()
              },
              handleBlur: () => {
                if (disabled.value) {
                  console.warn(
                    'useForm:',
                    'handleBlur() was blocked on a disabled field',
                    `(${context.value.path})`,
                  )
                  return
                }

                // console.debug(`======== handleBlur (${pathRef.value})`)
                if (updateCount.value === 0) return

                void validateField()
              },
              reset: () => {
                if (disabled.value) {
                  console.warn(
                    'useForm:',
                    'reset() was blocked on a disabled field',
                    `(${context.value.path})`,
                  )
                  return
                }
                // await hooks.callHook('beforeFieldReset')

                updateCount.value = 0
                setProperty(formData, context.value.path, initialValue.value)
                fieldError.value = undefined

                // await hooks.callHook('afterFieldReset')
              },
              isChanged: computed(
                () => !isDeepEqual<unknown>(fieldValue.value, initialValue.value),
              ),
              isDirty: computed(() => updateCount.value !== 0),
              value: readonly(fieldValue) as Ref<NonPrimitiveReadonly<T>>,
              path,
              key: `${path}@${now}`,
              validator: fieldValidator ? markRaw(fieldValidator) : undefined,
              [contextSymbol]: setContext,
            }) satisfies FormFieldInternal<T>

            Object.defineProperty(field, '$', {
              get() {
                return () => createFormFieldProxy(path)
              },
            })

            function setContext(ctx: typeof context.value) {
              context.value = ctx
              field.path = ctx.path
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

export type FormFieldTranslator<T, O> = {
  get: (v: T) => O
  set: (v: O) => T
}
type FormFieldAccessor<T> = {
  $use: <O>(opts?: { translate?: FormFieldTranslator<T, O> }) => FormField<IfUnknown<O, T, O>>
}

// eslint-disable-next-line unused-imports/no-unused-vars
declare const NullSymbol: unique symbol
type FormFieldAccessorDiscriminator<T, Discriminator extends string> = {
  $use: <
    Opts extends {
      discriminator?: Discriminator
    },
  >(
    opts?: Opts,
  ) => Opts extends { discriminator: string }
    ? {
        [D in (T[Extract<keyof T, Discriminator>] & string) | typeof NullSymbol]: Simplify<
          Record<Discriminator, D extends typeof NullSymbol ? null : D> & {
            $field: BuildFormFieldAccessors<
              D extends typeof NullSymbol ? null : Extract<T, Record<Discriminator, D>>,
              true
            >
          }
        >
      }[(T[Extract<keyof T, Discriminator>] & string) | typeof NullSymbol]
    : FormField<T>
}

type FormFieldAccessorOptions<T> = Parameters<FormFieldAccessor<T>['$use']>[0] &
  Parameters<FormFieldAccessorDiscriminator<T, string>['$use']>[0]

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

// type AAAAAAAAAA = BuildFormFieldAccessors<{
//   person: string
// }>
// type dddddddd = AAAAAAAAAA['']

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
