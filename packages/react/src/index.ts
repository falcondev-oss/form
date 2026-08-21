import type {
  FormField,
  FormFieldExtend,
  FormFieldProps,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from '@falcondev-oss/form-core'
import type { FunctionComponent, NamedExoticComponent } from 'react'
import {
  extend,
  resolveMaybeGetter,
  subscribeFormUpdates,
  useFormCore,
} from '@falcondev-oss/form-core'
import { memo, useEffect, useMemo, useReducer, useRef } from 'react'

export type FieldModelProps<T> = {
  model: FieldModel<T>
}

export type FieldModel<T> = {
  value: T
  onUpdate: (newValue: T) => void
}

/** Per-form render epoch, bumped after every flushed change. */
export type Tick = { value: number }

export const tick = Symbol('tick')

declare module '@falcondev-oss/form-core' {
  interface FormFieldExtend<T> {
    model: FieldModel<T>
    [tick]: Tick
  }
}

export function useForm<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
>(opts: FormOptions<Schema, SourceValues>): ReturnType<typeof useFormCore<Schema, SourceValues>> {
  const forceUpdate = useReducer((count) => count + 1, 0)[1]
  const submitRef = useRef(opts.submit)
  const sourceValuesRef = useRef(opts.sourceValues)

  const form = useMemo(() => {
    const tickBox: Tick = { value: 0 }

    const form = useFormCore({
      ...opts,
      submit: (ctx) => submitRef.current(ctx),
      sourceValues: () => resolveMaybeGetter(sourceValuesRef.current),
      [extend]: {
        setup: () =>
          ({ [tick]: tickBox }) as Omit<FormFieldExtend<any>, 'model'> as FormFieldExtend<any>,
        $use: (field) =>
          ({
            model: {
              get value() {
                return field.value
              },
              onUpdate: field.handleChange,
            },
          }) as Omit<FormFieldExtend<any>, typeof tick> as FormFieldExtend<any>,
      },
    })

    form['~'].subscribe(() => {
      tickBox.value++
      forceUpdate()
    })

    return form
  }, [])

  useEffect(() => {
    submitRef.current = opts.submit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.submit])

  useEffect(() => {
    sourceValuesRef.current = opts.sourceValues
    form['~'].refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.sourceValues])

  return form
}

export function useField<T>(_field: FormField<T>) {
  const forceUpdate = useReducer((count) => count + 1, 0)[1]

  useEffect(() => subscribeFormUpdates(forceUpdate), [])

  return _field
}

export function FormFieldMemo<T, P extends object>(
  component: FunctionComponent<P & FormFieldProps<T>>,
): NamedExoticComponent<P & FormFieldProps<T>> {
  const prevTick: { current: number | undefined } = { current: undefined }

  return memo(component, (prev, next) => {
    const nextTick = (next.field as unknown as Record<typeof tick, Tick>)[tick].value
    if (prevTick.current === nextTick) {
      return true // skip rerender
    }

    prevTick.current = (prev.field as unknown as Record<typeof tick, Tick>)[tick]?.value
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
