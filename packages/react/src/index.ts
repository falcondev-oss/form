import type { FormFieldProps, FormOptions, FormSchema } from '@falcondev-oss/form-core'
import type { Ref } from '@vue/reactivity'
import type { FunctionComponent, NamedExoticComponent } from 'react'
import type { ZodTypeAny } from 'zod'
import { extendsSymbol, useFormCore } from '@falcondev-oss/form-core'
import { refEffect } from '@falcondev-oss/form-core/reactive'
import { reactive, ref, watch } from '@vue/reactivity'
import { memo, useEffect, useMemo, useState } from 'react'

export type FieldModelProps<T> = {
  model: FieldModel<T>
}

export type FieldModel<T> = {
  value: T
  onUpdate: (newValue: T) => void
}

const tick = Symbol('tick')

declare module '@falcondev-oss/form-core' {
  // eslint-disable-next-line unused-imports/no-unused-vars
  interface FormField<T, V extends ZodTypeAny> {
    model: FieldModel<T>
    [tick]: Ref<number>
  }
}

export function useForm<const Schema extends FormSchema>(
  opts: FormOptions<Schema>,
): ReturnType<typeof useFormCore<Schema>> {
  const setTick = useState(0)[1]

  const { form, sourceValuesRef } = useMemo(() => {
    const sourceValuesRef = refEffect(opts.sourceValues)
    // watch(sourceValuesRef, () => {
    //   console.debug('useForm().watch -> rerender', { sourceValues: sourceValuesRef.value })
    // })

    const form = useFormCore({
      ...opts,
      sourceValues: () => sourceValuesRef.value,

      [extendsSymbol]: {
        $use: (field) => {
          // console.debug('$use()', field.path)

          const tickRef = ref(0)

          watch([field.errors, field.value], () => {
            // console.debug('$use().watch -> rerender', { errors: field.errors.value })
            tickRef.value = Date.now()
            setTick(Date.now())
          })

          return {
            model: reactive({
              value: field.value,
              onUpdate: field.handleChange,
            }),
            [tick]: tickRef,
          }
        },
      },
    })

    return {
      form,
      sourceValuesRef,
    }
  }, [])

  useEffect(() => {
    if (typeof opts.sourceValues === 'function') return
    // console.debug('useForm().useEffect(..., [opts.sourceValues])', opts.sourceValues)

    sourceValuesRef.value = opts.sourceValues
  }, [opts.sourceValues])

  useEffect(() => {
    // console.debug('useForm().useEffect', form.data)

    watch([form.errors, form.isSubmitting, form.isChanged, form.isDirty], () => {
      // console.debug('useForm().watch -> rerender', { isSubmitting: form.isSubmitting.value })
      setTick(Date.now())
    })
  }, [])

  return form
}

export function FormField<T, P extends object>(
  component: FunctionComponent<P & FormFieldProps<T>>,
): NamedExoticComponent<P & FormFieldProps<T>> {
  const prevTick = ref<unknown>()

  return memo(component, (prev, next) => {
    if (prevTick.value === next.field[tick].value) {
      return true // skip rerender
    }

    prevTick.value = prev.field[tick].value
    return false // rerender
  })
}

export { type FormFieldProps, type NullableLeaf } from '@falcondev-oss/form-core'
