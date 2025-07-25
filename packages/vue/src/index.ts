import type { FormOptions, FormSchema } from '@falcondev-oss/form-core'
import type { MaybeRef, MaybeRefOrGetter, WritableComputedRef } from 'vue'
import { extendsSymbol, useFormCore } from '@falcondev-oss/form-core'
import { computed, toValue } from 'vue'

declare module '@falcondev-oss/form-core' {
  interface FormField<T> {
    model: WritableComputedRef<T>
  }
}

export type FormHandle = {
  isChanged: MaybeRef<boolean>
  isSubmitting: MaybeRef<boolean>
  errors: MaybeRef<unknown> | undefined
  submit: () => Promise<unknown>
}

export function useFormHandles(forms: MaybeRefOrGetter<FormHandle[]>) {
  return computed(() => {
    const forms_ = toValue(forms)

    return {
      isChanged: forms_.some((f) => toValue(f.isChanged)),
      isSubmitting: forms_.some((f) => toValue(f.isSubmitting)),
      errors: forms_.find((f) => toValue(f.errors))?.errors,
      submit: async () => Promise.all(forms_.map(async (f) => f.submit())),
    } satisfies FormHandle
  })
}

export function useForm<const Schema extends FormSchema>(
  opts: FormOptions<Schema>,
): ReturnType<typeof useFormCore<Schema>> & { _v: 'new' } {
  const form = useFormCore({
    ...opts,
    [extendsSymbol]: {
      $use: ({ value, handleChange }) => {
        const model = computed({
          get: () => value.value,
          set: (v: typeof value.value) => handleChange(v),
        })

        return { model }
      },
    },
  })

  // TODO: remove _v type flag
  return { ...form, _v: 'new' as const }
}

export type {
  FormFieldProps,
  FormFields,
  FormFieldTranslator,
  NullableDeep,
} from '@falcondev-oss/form-core'
export { refEffect } from '@falcondev-oss/form-core/reactive'
