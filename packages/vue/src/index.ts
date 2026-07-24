import type {
  FormHandle,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from '@falcondev-oss/form-core'
import type { MaybeRefOrGetter } from 'vue'
import { extend, useFormCore } from '@falcondev-oss/form-core'
import { onScopeDispose, reactive, shallowRef, toValue, watch } from 'vue'

declare module '@falcondev-oss/form-core' {
  interface FormFieldExtend<T> {
    model: T
  }
}

type AdapterInternal = {
  updateSource: (value: unknown) => void
  updateSubmit: (submit: FormOptions<FormSchema>['submit']) => void
  notify: () => void
}

function emptySubscribe() {
  return () => {}
}

function read<T>(value: T | (() => T) | { readonly value: T }): T {
  if (typeof value === 'function') return (value as () => T)()
  if (value && typeof value === 'object' && 'value' in value) return value.value
  return value
}

export function useFormHandles(forms: MaybeRefOrGetter<FormHandle[]>) {
  const handle = reactive({
    get 'isChanged'() {
      return toValue(forms).some((form) => form.isChanged)
    },
    get 'isDirty'() {
      return toValue(forms).some((form) => form.isDirty)
    },
    get 'isLoading'() {
      return toValue(forms).some((form) => form.isLoading)
    },
    get 'isDisabled'() {
      return toValue(forms).some((form) => form.isDisabled)
    },
    get 'errors'() {
      return toValue(forms).find((form) => form.errors)?.errors
    },
    'submit': async () => Promise.all(toValue(forms).map(async (form) => form.submit())),
    'reset': () => {
      for (const form of toValue(forms)) form.reset()
    },
    'setData': function (recipe: Parameters<FormHandle['setData']>[0]) {
      for (const form of toValue(forms)) form.setData(recipe)
    },
    '~': {
      flush() {
        for (const form of toValue(forms)) form['~'].flush()
      },
      subscribe: emptySubscribe,
      getSnapshot: () => 0,
    },
    'hooks': {
      addHooks(configHooks) {
        const unsubscribe = toValue(forms).map((form) => form.hooks.addHooks(configHooks))
        return () => {
          for (const stop of unsubscribe) stop()
        }
      },
      hook(name, function_, options) {
        const unsubscribe = toValue(forms).map((form) => form.hooks.hook(name, function_, options))
        return () => {
          for (const stop of unsubscribe) stop()
        }
      },
      hookOnce(name, function_) {
        const unsubscribe = toValue(forms).map((form) => form.hooks.hookOnce(name, function_))
        return () => {
          for (const stop of unsubscribe) stop()
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
  const form = useFormCore({
    ...opts,
    sourceValues: read(opts.sourceValues),
    [extend]: {
      track: () => {
        void version.value
      },
      $use: (field) => {
        return {
          get model() {
            return field.value
          },
          set model(value) {
            field.handleChange(value)
          },
        }
      },
    },
  })
  const internal: AdapterInternal & (typeof form)['~'] = form['~']
  const stop = internal.subscribe(() => version.value++)
  onScopeDispose(stop, true)

  watch(
    () => read(opts.sourceValues),
    (value) => internal.updateSource(value),
    { deep: true },
  )
  watch(
    () => (opts.disabled ? read(opts.disabled) : false),
    () => internal.notify(),
  )
  watch(
    () => opts.submit,
    (submit) => internal.updateSubmit(submit),
  )

  const bridged = new Proxy(form, {
    get(target, property) {
      void version.value
      return (target as Record<PropertyKey, unknown>)[property]
    },
  })
  return Object.assign(reactive(bridged), { _v: 'new' } as const) as unknown as ReturnType<
    typeof useFormCore<Schema, SourceValues>
  > & { _v: 'new' }
}

export type {
  FormField,
  FormFieldProps,
  FormFields,
  FormFieldTranslator,
  FormHandle,
  NullableDeep,
} from '@falcondev-oss/form-core'
