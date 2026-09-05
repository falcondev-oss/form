import type {
  FormField,
  FormFieldProps,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from '@falcondev-oss/form-core'
import type { FunctionComponent, NamedExoticComponent } from 'react'
import { extend, useFormCore } from '@falcondev-oss/form-core'
import { createMemo, createSignal, flush } from '@solidjs/signals'
import { memo, useEffect, useMemo, useSyncExternalStore } from 'react'
import { subscribe, tick } from './util'

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
    /** changes whenever the field's state changed, see `FormFieldMemo` */
    [tick]: number
    [subscribe]: (listener: () => void) => () => void
  }
}

export type FormOptionsReact<
  Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
> = Omit<FormOptions<Schema, SourceValues>, 'sourceValues' | 'disabled'> & {
  sourceValues: SourceValues
  disabled?: boolean
}

export function useForm<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
>(
  opts: FormOptionsReact<Schema, SourceValues>,
): ReturnType<typeof useFormCore<Schema, SourceValues>> {
  const { form, setSourceValues, setDisabled, submitRef, onChange, getVersion } = useMemo(() => {
    const [sourceValues, setSourceValues] = createSignal(
      opts.sourceValues as Exclude<SourceValues, Function>,
    )
    const [disabled, setDisabled] = createSignal(opts.disabled ?? false)
    const submitRef = { current: opts.submit }

    let version = 0
    const versions = new WeakMap<object, number>()
    const listeners = new Set<() => void>()
    const onChange = (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }

    const form = useFormCore({
      ...opts,
      sourceValues,
      disabled,
      submit: async (...args) => submitRef.current(...args),
      [extend]: {
        $use: (field, scope) => {
          const model = createMemo(() => ({
            value: field.value,
            onUpdate: (value: typeof field.value) => {
              field.handleChange(value)
              flush()
            },
          }))

          return {
            get model() {
              return model()
            },
            get [tick]() {
              return versions.get(scope) ?? 0
            },
            [subscribe]: onChange,
          }
        },
      },
    })

    form['~'].subscribe((scope) => {
      version++
      versions.set(scope, (versions.get(scope) ?? 0) + 1)
      for (const listener of listeners) listener()
    })

    return { form, setSourceValues, setDisabled, submitRef, onChange, getVersion: () => version }
  }, [])

  useSyncExternalStore(onChange, getVersion)

  useEffect(() => {
    submitRef.current = opts.submit
  }, [opts.submit])

  useEffect(() => {
    setSourceValues(() => opts.sourceValues as Exclude<SourceValues, Function>)
  }, [opts.sourceValues])

  useEffect(() => {
    setDisabled(opts.disabled ?? false)
  }, [opts.disabled])

  return form
}

export function useField<T>(field: FormField<T>) {
  useSyncExternalStore(field[subscribe], () => field[tick])
  return field
}

export function FormFieldMemo<T, P extends object>(
  component: FunctionComponent<P & FormFieldProps<T>>,
): NamedExoticComponent<P & FormFieldProps<T>> {
  let prevTick: number | undefined

  return memo(component, (prev, next) => {
    if (prevTick === next.field[tick]) {
      return true // skip rerender
    }

    prevTick = prev.field[tick]
    return false // rerender
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
