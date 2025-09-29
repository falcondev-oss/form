import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { ComputedRef, Reactive, UnwrapNestedRefs } from '@vue/reactivity'
import type { Hookable, NestedHooks } from 'hookable'
import type {
  IfUnknown,
  IsAny,
  IsLiteral,
  IsSymbolLiteral,
  IsTuple,
  IsUnknown,
  PickIndexSignature,
  Primitive,
  Simplify,
  Writable,
} from 'type-fest'
import type { IsUnion } from 'type-fest/source/internal'
import type { ZodType } from 'zod/v4'

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
  GetDiscriminator<T> extends infer DiscriminatorKey
    ? T extends object
      ? T extends any[]
        ? NullableDeep<T[number]>[] | null
        : ObjectHasFunctionsOrSymbols<T> extends true
          ? T | null
          :
              | Simplify<{
                  [K in keyof T]: K extends DiscriminatorKey ? T[K] | null : NullableDeep<T[K]>
                }>
              | (keyof PickIndexSignature<T> extends never ? null : never)
      : T | null
    : never

export type FormSchema = StandardSchemaV1
export type FormData<Schema extends FormSchema> = NonNullable<
  NullableDeep<StandardSchemaV1.InferOutput<Schema>>
>

export const extend = Symbol('extend')

type MaybeGetter<T extends object | undefined> = T | (() => T)

export interface FormOptions<
  Schema extends FormSchema,
  Output extends StandardSchemaV1.InferOutput<Schema> = StandardSchemaV1.InferOutput<Schema>,
> {
  schema: Schema
  sourceValues: MaybeGetter<Writable<FormData<Schema>> | undefined>
  submit: (ctx: { values: Output }) => Promise<void | { success: boolean }>
  hooks?: NestedHooks<FormHooks<Schema>>
  [extend]?: {
    setup?: <T>(field: FormFieldInternal<T>) => FormFieldExtend<T>
    $use?: <T>(field: FormFieldInternal<T>) => FormFieldExtend<T>
  }
}

export interface FormHooks<Schema extends FormSchema> {
  beforeSubmit: (form: { data: Partial<FormData<Schema>> }) => Promise<void> | void
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

export const setContext = Symbol('setContext')

export type NonPrimitiveReadonly<T> = T extends Primitive ? T : Readonly<T>
export type FormFieldInternal<T> = {
  errors: string[] | undefined
  value: NonPrimitiveReadonly<T>
  handleChange: (value: T) => void
  handleBlur: () => void
  reset: () => void
  disabled: boolean
  isPending: boolean
  isDirty: boolean
  isChanged: boolean
  path: string
  key: string
  validator: ZodType | undefined
  $?: () => BuildFormFieldAccessors<any>
  [setContext]: (ctx: { path: string }) => void
}
export type FormFieldContext<T> = Parameters<FormFieldInternal<T>[typeof setContext]>[0]

// eslint-disable-next-line unused-imports/no-unused-vars
export interface FormFieldExtend<T> {}

export interface FormField<T>
  extends Omit<FormFieldInternal<T>, '$'>,
    UnwrapNestedRefs<FormFieldExtend<T>> {
  $: () => BuildFormFieldAccessors<T>
}

export type FormFieldProps<T> = { field: FormField<NullableDeep<T>> }

export type FormHandle = {
  isChanged: ComputedRef<boolean>
  isDirty: ComputedRef<boolean>
  isLoading: ComputedRef<boolean>
  errors: ComputedRef<readonly StandardSchemaV1.Issue[] | undefined>
  submit: () => Promise<unknown>
  reset: () => void
  hooks: Hookable<FormHooks<FormSchema>>
}

export type FormFieldTranslator<T, O> = {
  get: (v: T) => O
  set: (v: O) => T
}
export type FormFieldAccessor<T> = {
  $use: <O>(opts?: {
    translate?: FormFieldTranslator<T, O>
  }) => NoInfer<FormField<IfUnknown<O, T, O>>>
}

type FormFieldDiscriminatorAccessor<T, DiscriminatorKey extends PropertyKey> = {
  $use: <
    Opts extends {
      discriminator?: DiscriminatorKey
    },
  >(
    opts?: Opts,
  ) => Opts extends { discriminator: string }
    ? DistributeField<
        T,
        DiscriminatorKey,
        NonNullable<T>[Extract<keyof NonNullable<T>, DiscriminatorKey>]
      >
    : FormField<T>
}

type DistributeField<
  T,
  DiscriminatorKey extends PropertyKey,
  DiscriminatorValue,
> = DiscriminatorValue extends any
  ? Simplify<
      {
        [K in DiscriminatorKey]: Extract<
          NonNullable<T>[K & keyof NonNullable<T>],
          DiscriminatorValue
        >
      } & {
        $field: BuildFormFieldAccessors<
          T extends null
            ? ExtractByPropertyValue<T, DiscriminatorKey, DiscriminatorValue> | null
            : ExtractByPropertyValue<T, DiscriminatorKey, DiscriminatorValue>,
          true
        >
      }
    >
  : never

export type FormFieldAccessorOptions<T> = Parameters<FormFieldAccessor<T>['$use']>[0] &
  Parameters<FormFieldDiscriminatorAccessor<T, string>['$use']>[0]

export type GetDiscriminator<T> =
  IsUnion<T> extends true
    ? keyof Omit<
        {
          [K in keyof T as IsLiteral<NonNullable<T[K]>> extends true ? K : never]: T[K]
        },
        keyof SharedUnionValueKeys<T>
      >
    : never

type CollectUnionValuesByKey<T, K extends PropertyKey> = T extends unknown
  ? K extends keyof T
    ? T[K]
    : never
  : never

type IsDistinctUnionValue<
  T,
  K extends keyof T,
  CollectedValues extends CollectUnionValuesByKey<T, K> = CollectUnionValuesByKey<T, K>,
> = T extends any ? ([CollectedValues] extends [T[K]] ? false : true) : never

type SharedUnionValueKeys<T, Keys extends keyof T = keyof T> = {
  [K in Keys as IsDistinctUnionValue<T, K> extends false ? K : never]: true
}

export type FormFields<T> = BuildFormFieldAccessors<NullableDeep<T>>

export type BuildFormFieldAccessors<T, StopDiscriminator = false> = [IsAny<T>] extends [true]
  ? FormFieldAccessor<any> | FormFieldDiscriminatorAccessor<any, PropertyKey>
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
          ? // regular object
            FormFieldAccessor<T> & {
              [K in keyof NonNullable<T>]-?: BuildFormFieldAccessors<NonNullable<T>[K]>
            }
          : // discriminated union object
            GetDiscriminator<NonNullable<T>> extends infer DiscriminatorKey extends PropertyKey
            ? NonNullable<T> extends Record<
                DiscriminatorKey,
                infer DiscriminatorValue extends DiscriminatorValueType | null
              >
              ? DistributeDiscriminatedProperties<
                  NonNullable<T>,
                  DiscriminatorKey,
                  NonNullable<DiscriminatorValue>
                > &
                  // combine all discriminator values into one accessor:
                  // FormFieldAccessor<'A'> | FormFieldAccessor<'B'> => FormFieldAccessor<'A' | 'B'>
                  // also handles multiple discriminator keys
                  {
                    [K in DiscriminatorKey]: FormFieldAccessor<NonNullable<T>[K]>
                  } & FormFieldDiscriminatorAccessor<T, DiscriminatorKey>
              : never
            : never
      : FormFieldAccessor<T>

type DistributeDiscriminatedProperties<
  T,
  DiscriminatorKey extends PropertyKey,
  DiscriminatorValue,
> = T extends any
  ? // omit discriminator here -> is added as extra field above
    Omit<
      BuildFormFieldAccessors<
        ExtractByPropertyValue<NonNullable<T>, DiscriminatorKey, DiscriminatorValue>
      >,
      DiscriminatorKey
    >
  : never

type ExtractByPropertyValue<T, K extends PropertyKey, V> =
  T extends Record<K, infer U> ? (V extends U ? T : never) : never

type DiscriminatorValueType = string | number | symbol | boolean
