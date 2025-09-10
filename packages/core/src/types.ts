import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Reactive } from '@vue/reactivity'
import type { NestedHooks } from 'hookable'
import type {
  IfUnknown,
  IsAny,
  IsNever,
  IsStringLiteral,
  IsSymbolLiteral,
  IsTuple,
  IsUnknown,
  PickIndexSignature,
  Primitive,
  SetRequired,
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
export type FormData<Schema extends FormSchema> = NonNullable<
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

export const contextSymbol = Symbol('context')

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
export type FormFieldContext<T> = Parameters<FormFieldInternal<T>[typeof contextSymbol]>[0]

// eslint-disable-next-line unused-imports/no-unused-vars
export interface FormFieldExtend<T> {}

export interface FormField<T>
  extends Omit<FormFieldInternal<T>, '$'>,
    Reactive<FormFieldExtend<T>> {
  $: <TT extends T>() => BuildFormFieldAccessors<TT>
}
export type FormFieldProps<T> = { field: FormField<NullableDeep<T>> }

export type FormFieldTranslator<T, O> = {
  get: (v: T) => O
  set: (v: O) => T
}
export type FormFieldAccessor<T> = {
  $use: <O>(opts?: {
    translate?: FormFieldTranslator<T, O>
  }) => NoInfer<FormField<IfUnknown<O, T, O>>>
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

export type FormFieldAccessorOptions<T> = Parameters<FormFieldAccessor<T>['$use']>[0] &
  Parameters<FormFieldAccessorDiscriminator<T, string>['$use']>[0]

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

export type BuildFormFieldAccessors<T, StopDiscriminator = false> = [IsAny<T>] extends [true]
  ? FormFieldAccessor<any>
  : [IsNever<T>] extends [true]
    ? FormFieldAccessor<never>
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
            ? {
                [K in keyof NonNullable<T>]-?: BuildFormFieldAccessors<NonNullable<T>[K]>
              }
            : GetDiscriminator<NonNullable<T>> extends infer Discriminator extends string
              ? NonNullable<T> extends Record<Discriminator, infer Options extends string>
                ? {
                    [O in Options]: BuildFormFieldAccessors<
                      ExtractByPropertyValue<NonNullable<T>, Discriminator, O>
                    >
                  }[Options] &
                    FormFieldAccessorDiscriminator<NonNullable<T>, Discriminator>
                : never
              : never
        : FormFieldAccessor<T>

type ExtractByPropertyValue<T, K extends PropertyKey, V> =
  T extends Record<K, infer U> ? (V extends U ? T : never) : never
