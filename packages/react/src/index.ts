import type {
  FormField,
  FormFieldProps,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from '@falcondev-oss/form-core'
import type { FunctionComponent, NamedExoticComponent } from 'react'
import { extend, useFormCore } from '@falcondev-oss/form-core'
import { commit, observe, toValue, trackDeep } from '@falcondev-oss/form-core/reactive'
import { createMemo, createSignal } from '@solidjs/signals'
import { memo, useEffect, useMemo, useState } from 'react'
import { tick } from './util'

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
    [tick]: number
  }
}

function useRerender() {
  const setTick = useState(0)[1]
  return () => setTick((t) => t + 1)
}

export function useForm<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
>(opts: FormOptions<Schema, SourceValues>): ReturnType<typeof useFormCore<Schema, SourceValues>> {
  const rerender = useRerender()

  const { form, setSourceValues, submitFn } = useMemo(() => {
    // boxed: a getter is a valid sourceValues value and must not be called as a signal updater
    const [sourceValues, setSourceValues] = createSignal({ current: opts.sourceValues })
    const submitFn = { current: opts.submit }
    let tickValue = 0

    const form = useFormCore({
      ...opts,
      submit: async (...args) => submitFn.current(...args),
      sourceValues: () => toValue(sourceValues().current),
      [extend]: {
        setup: () => ({
          get [tick]() {
            return tickValue
          },
        }),
        $use: (field) => {
          observe(
            () => [field.errors, field.value],
            () => {
              tickValue++
              rerender()
            },
          )

          // memoized, so `field.model` keeps its identity between renders
          const model = createMemo(() => ({ value: field.value, onUpdate: field.handleChange }))
          return {
            get model() {
              return model()
            },
          }
        },
      },
    })

    return { form, setSourceValues, submitFn }
  }, [])

  useEffect(() => {
    submitFn.current = opts.submit
  }, [opts.submit])

  useEffect(() => {
    if (typeof opts.sourceValues === 'function') return
    commit(() => setSourceValues({ current: opts.sourceValues }))
  }, [opts.sourceValues])

  useEffect(
    () => observe(() => [form.errors, form.isLoading, form.isChanged, form.isDirty], rerender),
    [],
  )

  return form
}

export function useField<T>(field: FormField<T>) {
  const rerender = useRerender()
  useEffect(() => observe(() => trackDeep({ ...field }), rerender), [field])

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
