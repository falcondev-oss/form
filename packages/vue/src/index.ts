import type {
  FormHandle,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from '@falcondev-oss/form-core'
import type { MaybeRefOrGetter, WritableComputedRef } from 'vue'
import { extend, useFormCore } from '@falcondev-oss/form-core'
import { computed, reactive, toValue } from 'vue'

declare module '@falcondev-oss/form-core' {
  interface FormFieldExtend<T> {
    model: WritableComputedRef<T>
  }
}

export function useFormHandles(forms: MaybeRefOrGetter<FormHandle[]>) {
  const handle = reactive({
    isChanged: computed(() => toValue(forms).some((f) => f.isChanged)),
    isDirty: computed(() => toValue(forms).some((f) => f.isDirty)),
    isLoading: computed(() => toValue(forms).some((f) => f.isLoading)),
    errors: computed(() => toValue(forms).find((f) => f.errors)?.errors),
    submit: async () => Promise.all(toValue(forms).map(async (f) => f.submit())),
    reset: () => {
      for (const f of toValue(forms)) f.reset()
    },
    hooks: {
      addHooks(configHooks) {
        const unsub = toValue(forms).map((f) => f.hooks.addHooks(configHooks))
        return () => {
          for (const u of unsub) u()
        }
      },
      hook(name, function_, options) {
        const unsub = toValue(forms).map((f) => f.hooks.hook(name, function_, options))
        return () => {
          for (const u of unsub) u()
        }
      },
      hookOnce(name, function_) {
        const unsub = toValue(forms).map((f) => f.hooks.hookOnce(name, function_))
        return () => {
          for (const u of unsub) u()
        }
      },
    } satisfies FormHandle['hooks'],
  })

  return handle satisfies FormHandle
}

export function useForm<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema>,
>(
  opts: FormOptions<Schema, SourceValues>,
): ReturnType<typeof useFormCore<Schema, SourceValues>> & { _v: 'new' } {
  const form = useFormCore({
    ...opts,
    [extend]: {
      $use: (field) => {
        const model = computed({
          get: () => field.value,
          set: (v) => field.handleChange(v),
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
  FormHandle,
  NullableDeep,
} from '@falcondev-oss/form-core'
export { refEffect } from '@falcondev-oss/form-core/reactive'
