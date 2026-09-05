import type {
  FormField,
  FormFieldProps,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from '@falcondev-oss/form-core'
import type { FunctionComponent, NamedExoticComponent } from 'react'
import { extend, useFormCore } from '@falcondev-oss/form-core'
import { createElement, memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'

export type FieldModelProps<T> = { model: FieldModel<T> }
export type FieldModel<T> = { value: T; onUpdate: (newValue: T) => void }
const subscription = Symbol('subscription')
type Subscription = { subscribe: (listener: () => void) => () => void; getSnapshot: () => number }

declare module '@falcondev-oss/form-core' {
  interface FormFieldExtend<T> {
    model: FieldModel<T>
    [subscription]: Subscription
  }
}

export function useForm<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
>(opts: FormOptions<Schema, SourceValues>): ReturnType<typeof useFormCore<Schema, SourceValues>> {
  const current = useRef(opts)
  current.current = opts
  const [form] = useState(() =>
    useFormCore({
      ...opts,
      submit: (ctx) => current.current.submit(ctx),
      [extend]: {
        $use: (field) => ({
          get model() {
            return { value: field.value, onUpdate: field.handleChange }
          },
          get [subscription](): Subscription {
            return form['~']
          },
        }),
      },
    }),
  )
  useSyncExternalStore(form['~'].subscribe, form['~'].getSnapshot, form['~'].getSnapshot)
  useEffect(() => {
    form['~'].updateOptions({ ...opts, submit: (ctx) => current.current.submit(ctx) })
  }, [opts.sourceValues, opts.disabled])
  // Delay disposal one microtask so Strict Mode's effect replay can resubscribe.
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      queueMicrotask(() => {
        if (!mounted.current) form['~'].dispose()
      })
    }
  }, [form])
  return form
}

export function useField<T>(field: FormField<T>) {
  const source = field[subscription]
  useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  return field
}

export function FormFieldMemo<T, P extends object>(
  component: FunctionComponent<P & FormFieldProps<T>>,
): NamedExoticComponent<P & FormFieldProps<T>> {
  return memo((props: P & FormFieldProps<T>) => {
    useField(props.field)
    return createElement(component, props)
  })
}

export type {
  FormField,
  FormFieldProps,
  FormFields,
  FormFieldTranslator,
  FormHandle,
  NullableDeep,
} from '@falcondev-oss/form-core'
