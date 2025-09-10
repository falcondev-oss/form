import type {
  FormFieldExtend,
  FormFieldProps,
  FormOptions,
  FormSchema,
} from '@falcondev-oss/form-core'
import type { ComputedRef } from '@vue/reactivity'
import type { FunctionComponent, NamedExoticComponent } from 'react'
import { extend, useFormCore } from '@falcondev-oss/form-core'
import { refEffect } from '@falcondev-oss/form-core/reactive'
import { computed, ref, watch } from '@vue/reactivity'
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
    model: ComputedRef<FieldModel<T>>
    [tick]: number // Ref<number> // wait for https://github.com/vuejs/core/pull/13740
  }
}

export function useForm<const Schema extends FormSchema>(
  opts: FormOptions<Schema>,
): ReturnType<typeof useFormCore<Schema>> {
  const setTick = useState(0)[1]

  const { form, sourceValuesRef, submitFnRef } = useMemo(() => {
    const sourceValuesRef = refEffect(opts.sourceValues)
    const submitFnRef = ref(opts.submit)
    // watch(sourceValuesRef, () => {
    //   console.debug('useForm().watch -> rerender', { sourceValues: sourceValuesRef.value })
    // })

    const tickRef = ref(0)
    const form = useFormCore({
      ...opts,
      submit: async (...args) => submitFnRef.value(...args),

      sourceValues: () => sourceValuesRef.value,
      [extend]: {
        setup: () => {
          return {
            [tick]: tickRef as unknown as number, // wait for https://github.com/vuejs/core/pull/13740
          } satisfies Omit<FormFieldExtend<any>, 'model'> as FormFieldExtend<any>
        },
        $use: (field) => {
          // console.debug('$use()', field.path)

          watch(
            () => [field.errors, field.value],
            () => {
              // console.debug('$use().watch -> rerender', { errors: field.errors })
              tickRef.value = Date.now()
              setTick(Date.now())
            },
          )

          return {
            // this needs to be a computed to ensure reactivity, because useForm is memoized
            model: computed(() => ({
              value: field.value,
              onUpdate: field.handleChange,
            })),
          } satisfies Omit<FormFieldExtend<any>, typeof tick> as FormFieldExtend<any>
        },
      },
    })

    return {
      form,
      sourceValuesRef,
      submitFnRef,
    }
  }, [])

  useEffect(() => {
    submitFnRef.value = opts.submit
  }, [opts.submit])

  useEffect(() => {
    if (typeof opts.sourceValues === 'function') return
    // console.debug('useForm().useEffect(..., [opts.sourceValues])', opts.sourceValues)

    sourceValuesRef.value = opts.sourceValues
  }, [opts.sourceValues])

  useEffect(() => {
    // console.debug('useForm().useEffect', form.data)

    watch([form.errors, form.isLoading, form.isChanged, form.isDirty], () => {
      // console.debug('useForm().watch -> rerender', { isLoading: form.isLoading.value })
      setTick(Date.now())
    })
  }, [])

  return form
}

export function FormFieldMemo<T, P extends object>(
  component: FunctionComponent<P & FormFieldProps<T>>,
): NamedExoticComponent<P & FormFieldProps<T>> {
  const prevTick = ref<unknown>()

  return memo(component, (prev, next) => {
    if (prevTick.value === next.field[tick]) {
      return true // skip rerender
    }

    prevTick.value = prev.field[tick]
    return false // rerender
  })
}

export type {
  FormField,
  FormFieldProps,
  FormFields,
  FormFieldTranslator,
  NullableDeep,
} from '@falcondev-oss/form-core'
