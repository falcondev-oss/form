import type { FormHandle, FormOptions, FormSchema } from '@falcondev-oss/form-core'
import type { MaybeRefOrGetter, UnwrapNestedRefs, WritableComputedRef } from 'vue'
import { extend, useFormCore } from '@falcondev-oss/form-core'
import { computed, toValue } from 'vue'

declare module '@falcondev-oss/form-core' {
  interface FormFieldExtend<T> {
    model: WritableComputedRef<T>
  }
}

export function useFormHandles(forms: MaybeRefOrGetter<FormHandle[]>) {
  return computed(() => {
    const forms_ = toValue(forms)

    return {
      isChanged: forms_.some((f) => f.isChanged.value),
      isDirty: forms_.some((f) => f.isDirty.value),
      isLoading: forms_.some((f) => f.isLoading.value),
      errors: forms_.find((f) => f.errors.value)?.errors.value,
      submit: async () => Promise.all(forms_.map(async (f) => f.submit())),
      reset: () => {
        for (const f of forms_) f.reset()
      },
    } satisfies UnwrapNestedRefs<Omit<FormHandle, 'hooks'>>
  })
}

export function useForm<const Schema extends FormSchema>(
  opts: FormOptions<Schema>,
): ReturnType<typeof useFormCore<Schema>> & { _v: 'new' } {
  const form = useFormCore({
    ...opts,
    [extend]: {
      $use: (field) => {
        const model = computed({
          get: () => field.value,
          set: (v: typeof field.value) => field.handleChange(v),
        })

        return { model }
      },
    },
  })

  // TODO: remove _v type flag
  return { ...form, _v: 'new' as const }
}

export type {
  FormField,
  FormFieldProps,
  FormFields,
  FormFieldTranslator,
  NullableDeep,
} from '@falcondev-oss/form-core'
export { refEffect } from '@falcondev-oss/form-core/reactive'
