import type { FormHooks, FormOptions, FormSchema } from '@falcondev-oss/form-core'
import type { Hookable } from 'hookable'
import type { MaybeRefOrGetter, Ref, ShallowRef, WritableComputedRef } from 'vue'
import { extendsSymbol, useFormCore } from '@falcondev-oss/form-core'
import { computed, toValue } from 'vue'

declare module '@falcondev-oss/form-core' {
  interface FormField<T> {
    model: WritableComputedRef<T>
  }
}

type MaybeNonWritableRef<T> = T | Ref<T, T> | ShallowRef<T, T>

export type FormHandle = {
  isChanged: MaybeNonWritableRef<boolean>
  isSubmitting: MaybeNonWritableRef<boolean>
  errors: MaybeNonWritableRef<unknown> | undefined
  submit: () => Promise<unknown>
  reset: () => void
  hooks: Hookable<FormHooks<FormSchema>>
}

export function useFormHandles(forms: MaybeRefOrGetter<FormHandle[]>) {
  return computed(() => {
    const forms_ = toValue(forms)

    return {
      isChanged: forms_.some((f) => toValue(f.isChanged)),
      isSubmitting: forms_.some((f) => toValue(f.isSubmitting)),
      errors: forms_.find((f) => toValue(f.errors))?.errors,
      submit: async () => Promise.all(forms_.map(async (f) => f.submit())),
      reset: () => {
        for (const f of forms_) f.reset()
      },
    } satisfies Omit<FormHandle, 'hooks'>
  })
}

export function useForm<const Schema extends FormSchema>(
  opts: FormOptions<Schema>,
): ReturnType<typeof useFormCore<Schema>> & { _v: 'new' } {
  const form = useFormCore({
    ...opts,
    [extendsSymbol]: {
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
  FormFieldProps,
  FormFields,
  FormFieldTranslator,
  NullableDeep,
} from '@falcondev-oss/form-core'
export { refEffect } from '@falcondev-oss/form-core/reactive'
