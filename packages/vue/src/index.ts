import type {
  FormHandle,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from '@falcondev-oss/form-core'
import type { MaybeRefOrGetter } from 'vue'
import { extend, useFormCore } from '@falcondev-oss/form-core'
import {
  computed,
  getCurrentScope,
  nextTick,
  onScopeDispose,
  reactive,
  shallowRef,
  toValue,
  watch,
} from 'vue'

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

export function useForm<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
>(
  opts: Omit<FormOptions<Schema, SourceValues>, 'sourceValues' | 'disabled'> & {
    sourceValues: MaybeRefOrGetter<SourceValues>
    disabled?: MaybeRefOrGetter<boolean>
  },
): ReturnType<typeof useFormCore<Schema, SourceValues>> {
  const version = shallowRef(0)
  const wrappers = new WeakMap<object, object>()
  function bridge<T extends object>(value: T): T {
    const cached = wrappers.get(value)
    if (cached) return cached as T
    const wrapped = new Proxy(value, {
      get(target, key, receiver) {
        void version.value
        return Reflect.get(target, key, receiver)
      },
    })
    wrappers.set(value, wrapped)
    return wrapped
  }
  const getOptions = () => ({
    ...opts,
    sourceValues: toValue(opts.sourceValues),
    disabled: opts.disabled === undefined ? false : toValue(opts.disabled),
  })
  const form = useFormCore({
    ...getOptions(),
    [extend]: {
      wrap: bridge,
      $use: (field) => ({
        get model() {
          void version.value
          return field.value
        },
        set model(value) {
          field.handleChange(value)
        },
      }),
    },
  })
  const unsubscribe = form['~'].subscribe(() => {
    const focused = typeof document === 'undefined' ? null : document.activeElement
    version.value++
    // Vue's keyed DOM moves can blur an input even though its node survives.
    void nextTick(() => {
      if (
        focused &&
        focused instanceof HTMLElement &&
        focused.isConnected &&
        document.activeElement === document.body
      ) {
        focused.focus({ preventScroll: true })
      }
    })
  })
  const stop = watch(getOptions, (next) => form['~'].updateOptions(next), { deep: true })
  if (getCurrentScope())
    onScopeDispose(() => {
      stop()
      unsubscribe()
      form['~'].dispose()
    })
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
