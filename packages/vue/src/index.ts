import type {
  FormField,
  FormFieldExtend,
  FormFieldInternal,
  FormHandle,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from '@falcondev-oss/form-core'
import type { MaybeRefOrGetter, ShallowRef } from 'vue'
import { extend, useFormCore } from '@falcondev-oss/form-core'
import { computed, isReactive, isRef, reactive, shallowRef, toValue, watch } from 'vue'

declare module '@falcondev-oss/form-core' {
  // runtime value is a writable computed stored inside a reactive object:
  // reads unwrap to T and writes route back into the computed
  interface FormFieldExtend<T> {
    model: T
  }
}

export function useFormHandles(forms: MaybeRefOrGetter<FormHandle[]>) {
  const handle = reactive({
    'isChanged': computed(() => toValue(forms).some((f) => f.isChanged)),
    'isDirty': computed(() => toValue(forms).some((f) => f.isDirty)),
    'isLoading': computed(() => toValue(forms).some((f) => f.isLoading)),
    'isDisabled': computed(() => toValue(forms).some((f) => f.isDisabled)),
    'errors': computed(() => toValue(forms).find((f) => f.errors)?.errors),
    'submit': async () => Promise.all(toValue(forms).map(async (f) => f.submit())),
    'reset': () => {
      for (const f of toValue(forms)) f.reset()
    },
    'setData': (recipe: (draft: any) => void) => {
      for (const f of toValue(forms)) f.setData(recipe)
    },
    // per-form internals make no sense across an aggregate handle
    '~': {} as unknown as FormHandle['~'],
    'hooks': {
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

/**
 * Bridges engine notifications into Vue reactivity: every property access on
 * the wrapped handle/field tracks `version`, which is bumped after each
 * flushed change.
 */
function createTracker(version: ShallowRef<number>) {
  const cache = new WeakMap<object, unknown>()
  // view -> wrapped target, so writes never store views back into the engine
  const targets = new WeakMap<object, unknown>()

  function toVueField<T>(api: FormFieldInternal<T>): FormField<T> {
    const view = {
      get disabled() {
        void version.value
        return api.disabled
      },
      get errors() {
        void version.value
        return api.errors
      },
      get schema() {
        void version.value
        return api.schema
      },
      get value() {
        void version.value
        return api.value
      },
      get isChanged() {
        void version.value
        return api.isChanged
      },
      get isDirty() {
        void version.value
        return api.isDirty
      },
      get isPending() {
        void version.value
        return api.isPending
      },
      get path() {
        return api.path
      },
      get key() {
        return api.key
      },
      handleChange: (value: T) => api.handleChange(value),
      handleBlur: () => api.handleBlur(),
      reset: () => api.reset(),
      $: () => wrap(api.$()),
      // writable computed injected via [extend]; reactive() unwraps it on read
      // and routes writes back into the ref
      model: (api as unknown as Record<string, unknown>).model,
    }
    return reactive(view as Record<string, unknown>) as unknown as FormField<T>
  }

  function wrap<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value
    if (isRef(value) || isReactive(value)) return value
    if (value instanceof Promise) return value

    let wrapped = cache.get(value)
    if (!wrapped) {
      wrapped = new Proxy(value, handler)
      cache.set(value, wrapped)
      targets.set(wrapped as object, value)
    }
    return wrapped as T
  }

  function unwrap(view: unknown): unknown {
    return targets.get(view as object) ?? (view as object)
  }

  const handler: ProxyHandler<any> = {
    get(target, prop, receiver) {
      void version.value

      if (prop === '$use') {
        return (...args: unknown[]) => {
          const raw = Reflect.get(target, prop, receiver) as (...args: unknown[]) => unknown
          const result = raw.apply(target, args)
          if (result !== null && typeof result === 'object' && 'handleChange' in result) {
            return toVueField(result as FormFieldInternal<unknown>)
          }
          return wrap(result)
        }
      }

      const value = Reflect.get(target, prop, receiver)
      if (typeof value === 'function') {
        return (...args: unknown[]) => wrap(value.apply(target, args.map(unwrap)))
      }
      return wrap(value)
    },
    set(target, prop, value) {
      Reflect.set(target, prop, unwrap(value))
      return true
    },
    has(target, prop) {
      void version.value
      return Reflect.has(target, prop)
    },
    ownKeys(target) {
      void version.value
      return Reflect.ownKeys(target)
    },
  }

  return { wrap, toVueField }
}

export function useForm<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
>(
  opts: FormOptions<Schema, SourceValues>,
): ReturnType<typeof useFormCore<Schema, SourceValues>> & { _v: 'new' } {
  const version = shallowRef(0)

  const form = useFormCore({
    ...opts,
    sourceValues: () => toValue(opts.sourceValues),
    disabled: opts.disabled === undefined ? undefined : () => toValue(opts.disabled) ?? false,
    [extend]: {
      $use: (field) => {
        const model = computed({
          get: () => {
            void version.value
            return field.value
          },
          set: (v) => field.handleChange(v),
        })

        return { model } as unknown as FormFieldExtend<any>
      },
    },
  })

  // bridge engine notifications into Vue reactivity
  form['~'].subscribe(() => {
    version.value++
  })

  // push external source updates into the engine
  watch(
    () => toValue(opts.sourceValues),
    () => form['~'].refresh(),
  )
  watch(
    () => toValue(opts.disabled),
    () => {
      version.value++
    },
  )

  const { wrap } = createTracker(version)

  // TODO: remove _v type flag
  return Object.assign(wrap(form), { _v: 'new' } as const)
}

export type {
  FormField,
  FormFieldProps,
  FormFields,
  FormFieldTranslator,
  FormHandle,
  NullableDeep,
} from '@falcondev-oss/form-core'
