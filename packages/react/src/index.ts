import type {
  FormField,
  FormFieldProps,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from '@falcondev-oss/form-core'
import type { FunctionComponent, NamedExoticComponent } from 'react'
import { extend, useFormCore } from '@falcondev-oss/form-core'
import { memo, useEffect, useMemo, useSyncExternalStore } from 'react'

export type FieldModelProps<T> = {
  model: FieldModel<T>
}

export type FieldModel<T> = {
  value: T
  onUpdate: (newValue: T) => void
}

declare module '@falcondev-oss/form-core' {
  interface FormFieldExtend<T> {
    model: FieldModel<T>
  }
}

type AdapterInternal = {
  updateSource: (value: unknown) => void
  updateSubmit: (submit: FormOptions<FormSchema>['submit']) => void
}

function read<T>(value: T | (() => T)) {
  return typeof value === 'function' ? (value as () => T)() : value
}

export function useForm<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
>(opts: FormOptions<Schema, SourceValues>): ReturnType<typeof useFormCore<Schema, SourceValues>> {
  const form = useMemo(
    () =>
      useFormCore({
        ...opts,
        sourceValues: opts.sourceValues,
        [extend]: {
          $use: (field) => ({
            get model() {
              return { value: field.value, onUpdate: field.handleChange }
            },
          }),
        },
      }),
    [],
  )
  const internal: AdapterInternal & (typeof form)['~'] = form['~']
  useSyncExternalStore(internal.subscribe, internal.getSnapshot, internal.getSnapshot)

  useEffect(() => {
    internal.updateSubmit(opts.submit)
  }, [opts.submit])

  useEffect(() => {
    internal.updateSource(read(opts.sourceValues))
  }, [opts.sourceValues])

  return form
}

export function useField<T>(field: FormField<T>) {
  const internal = (
    field as unknown as {
      '~': {
        subscribe: (listener: () => void) => () => void
        getSnapshot: () => number
      }
    }
  )['~']
  useSyncExternalStore(internal.subscribe, internal.getSnapshot, internal.getSnapshot)
  return field
}

export function FormFieldMemo<T, P extends object>(
  component: FunctionComponent<P & FormFieldProps<T>>,
): NamedExoticComponent<P & FormFieldProps<T>> {
  return memo((props: P & FormFieldProps<T>): ReturnType<typeof component> => {
    useField(props.field)
    return component(props)
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
