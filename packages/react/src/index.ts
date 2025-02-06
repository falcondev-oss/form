import type { ZodTypeAny } from 'zod'
import {
  extendsSymbol,
  type FormFieldProps,
  type FormOptions,
  type FormSchema,
  useFormCore,
} from '@falcondev-oss/form-core'

import { reactive, type Ref, ref, watch } from '@vue/reactivity'

import {
  type FunctionComponent,
  memo,
  type NamedExoticComponent,
  useEffect,
  useMemo,
  useState,
} from 'react'

export type FieldModelProps<T> = {
  model: FieldModel<T>
}

export type FieldModel<T> = {
  value: T
  onUpdate: (newValue: T) => void
}

const tick = Symbol('tick')

declare module '@falcondev-oss/form-core' {
  // eslint-disable-next-line unused-imports/no-unused-vars, no-shadow
  interface FormField<T, V extends ZodTypeAny> {
    model: FieldModel<T>
    [tick]: Ref<number>
  }
}

export function useForm<const Schema extends FormSchema>(
  opts: FormOptions<Schema>,
): ReturnType<typeof useFormCore<Schema>> {
  const setTick = useState(0)[1]

  const form = useMemo(
    () =>
      useFormCore<Schema>({
        ...opts,

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
      }),
    [],
  )

  useEffect(() => {
    // console.debug('useForm().useEffect', form.data)

    watch([form.errors, form.isSubmitting], () => {
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
