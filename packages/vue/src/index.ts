import type {
  FormHandle,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from '@falcondev-oss/form-core'
import type { MaybeRefOrGetter } from 'vue'
import { extend, useFormCore } from '@falcondev-oss/form-core'
import { commit } from '@falcondev-oss/form-core/reactive'
import { createRoot, createSignal, getOwner, runWithOwner } from '@solidjs/signals'
import { computed, getCurrentScope, onScopeDispose, reactive, toRaw, toValue, watch } from 'vue'
import { createVueBridge } from './bridge'

declare module '@falcondev-oss/form-core' {
  interface FormFieldExtend<T> {
    /** Writable for `v-model`: reads `field.value`, writes through `field.handleChange()`. */
    model: T
  }
}

/** Mirrors a Vue ref or getter into a Solid signal. */
function toSolid<T>(source: MaybeRefOrGetter<T>) {
  // boxed: a getter is a valid value and must not be called as a signal updater
  const [value, setValue] = createSignal({ current: toRaw(toValue(source)) })
  watch(
    () => toRaw(toValue(source)),
    (current) => commit(() => setValue({ current })),
    { flush: 'sync' },
  )
  return () => value().current
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
): ReturnType<typeof useFormCore<Schema, SourceValues>> & { _v: 'new' } {
  const owner = createRoot((dispose) => {
    if (getCurrentScope()) onScopeDispose(dispose)
    return getOwner()!
  })

  const form = runWithOwner(owner, () =>
    useFormCore({
      ...opts,
      sourceValues: toSolid(opts.sourceValues),
      disabled: toSolid(opts.disabled ?? false),
      [extend]: {
        $use: (field) => ({
          get model() {
            return field.value
          },
          set model(value) {
            field.handleChange(value)
          },
        }),
      },
    }),
  )

  // TODO: remove _v type flag
  return Object.assign(createVueBridge(owner).toVue(form), { _v: 'new' } as const)
}

export type {
  FormField,
  FormFieldProps,
  FormFields,
  FormFieldTranslator,
  FormHandle,
  NullableDeep,
} from '@falcondev-oss/form-core'
