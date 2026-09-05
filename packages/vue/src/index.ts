import type {
  FormHandle,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from '@falcondev-oss/form-core'
import type { MaybeRefOrGetter, ShallowRef } from 'vue'
import { extend, useFormCore } from '@falcondev-oss/form-core'
import { createSignal, flush } from '@solidjs/signals'
import { computed, onScopeDispose, reactive, shallowRef, toValue, triggerRef, watch } from 'vue'

declare module '@falcondev-oss/form-core' {
  interface FormFieldExtend<T> {
    model: T
  }
}

export function useFormHandles(forms: MaybeRefOrGetter<FormHandle[]>) {
  const handle = reactive({
    isChanged: computed(() => toValue(forms).some((f) => f.isChanged)),
    isDirty: computed(() => toValue(forms).some((f) => f.isDirty)),
    isLoading: computed(() => toValue(forms).some((f) => f.isLoading)),
    isDisabled: computed(() => toValue(forms).some((f) => f.isDisabled)),
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

/** feeds a Vue ref/getter into a Solid signal */
function toSignal<T>(source: MaybeRefOrGetter<T>): () => T {
  const [get, set] = createSignal(toValue(source) as Exclude<T, Function>)
  watch(
    () => toValue(source),
    (value) => set(() => value),
    { flush: 'sync' },
  )
  return get
}

export type FormOptionsVue<
  Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
> = Omit<FormOptions<Schema, SourceValues>, 'sourceValues' | 'disabled'> & {
  sourceValues: MaybeRefOrGetter<SourceValues>
  disabled?: MaybeRefOrGetter<boolean>
}

export function useForm<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
>(
  opts: FormOptionsVue<Schema, SourceValues>,
): ReturnType<typeof useFormCore<Schema, SourceValues>> {
  // one Vue trigger per form/field api, bumped after every flush that changed it
  const triggers = new WeakMap<object, ShallowRef<number>>()
  function trigger(scope: object) {
    let ref = triggers.get(scope)
    if (!ref) triggers.set(scope, (ref = shallowRef(0)))
    return ref
  }

  const form = useFormCore({
    ...opts,
    sourceValues: toSignal(opts.sourceValues),
    disabled: toSignal(() => toValue(opts.disabled) ?? false),
    [extend]: {
      track: (scope) => void trigger(scope).value,
      $use: (field) => ({
        get model() {
          return field.value
        },
        set model(value) {
          field.handleChange(value)
          flush()
        },
      }),
    },
  })

  form['~'].subscribe((scope) => triggerRef(trigger(scope)))
  onScopeDispose(form['~'].dispose, true)

  return form
}

export type {
  FormField,
  FormFieldProps,
  FormFields,
  FormFieldTranslator,
  FormHandle,
  NullableDeep,
} from '@falcondev-oss/form-core'
