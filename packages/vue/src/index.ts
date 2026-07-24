import type {
  FormHandle,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from '@falcondev-oss/form-core'
import type { MaybeRefOrGetter, WritableComputedRef } from 'vue'
import { extend, useFormCore } from '@falcondev-oss/form-core'
import { createEffect, createRoot, deep, flush } from '@solidjs/signals'
import { computed, getCurrentScope, reactive, shallowRef, toValue, watch } from 'vue'

declare module '@falcondev-oss/form-core' {
  interface FormFieldExtend<T> {
    model: WritableComputedRef<T>
  }
}

// Re-expose Solid store reactivity to Vue: any tracked read routes through a
// bumped ref so Vue re-evaluates when the store flushes.
type Version = { value: number }

function bridgeGetters(obj: object, version: Version) {
  for (const key of Object.getOwnPropertyNames(obj)) {
    const desc = Object.getOwnPropertyDescriptor(obj, key)
    if (!desc?.get || !desc.configurable) continue
    // eslint-disable-next-line ts/unbound-method
    const origGet = desc.get
    Object.defineProperty(obj, key, {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        void version.value
        return origGet.call(this) as unknown
      },
      // eslint-disable-next-line ts/unbound-method
      set: desc.set,
    })
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
  opts: FormOptions<Schema, SourceValues>,
): ReturnType<typeof useFormCore<Schema, SourceValues>> & { _v: 'new' } {
  const version = shallowRef(0)

  const form = useFormCore<Schema, SourceValues>({
    ...opts,
    // read source untracked at init; reactive vue sources are bridged below
    sourceValues: () => toValue(opts.sourceValues as MaybeRefOrGetter<SourceValues>),
    [extend]: {
      $use: (field) => {
        bridgeGetters(field, version)
        const model = computed({
          get: () => field.value,
          set: (v) => {
            field.handleChange(v)
            flush()
          },
        })
        Object.defineProperty(field, 'model', {
          configurable: true,
          get: () => model.value,
          set: (v: (typeof field)['value']) => {
            model.value = v
          },
        })
        return {} as never
      },
    },
  })

  // Solid → Vue: bump `version` whenever the store or form flags settle.
  createRoot(() => {
    createEffect(
      () => {
        deep((form as unknown as { '~': { store: object } })['~'].store)
        void form.isDirty
        void form.isChanged
        void form.isLoading
        void form.errors
      },
      () => {
        version.value++
      },
      { defer: true },
    )
  })

  // Vue → Solid: a reactive vue source can't be tracked by the Solid engine, so
  // re-sync on change via reset() (which re-reads the current source), honoring
  // the dirty-guard exactly like the core's own source-update path.
  if (getCurrentScope()) {
    watch(
      () => toValue(opts.sourceValues as MaybeRefOrGetter<SourceValues>),
      () => {
        if (!form.isDirty) form.reset()
      },
      { deep: true },
    )
  }

  const wrapped = reactive(
    new Proxy(form as object, {
      get(target, prop, receiver) {
        void version.value
        return Reflect.get(target, prop, receiver) as unknown
      },
    }),
  )

  return Object.assign(wrapped, { _v: 'new' } as const) as never
}

export type {
  FormField,
  FormFieldProps,
  FormFields,
  FormFieldTranslator,
  FormHandle,
  NullableDeep,
} from '@falcondev-oss/form-core'
