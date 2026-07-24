import type {
  FormField,
  FormFieldProps,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from '@falcondev-oss/form-core'
import type { Owner } from '@solidjs/signals'
import type { FunctionComponent, NamedExoticComponent } from 'react'
import { extend, useFormCore } from '@falcondev-oss/form-core'
import {
  createEffect,
  createRoot,
  createSignal,
  flush,
  getOwner,
  runWithOwner,
} from '@solidjs/signals'
import { memo, useEffect, useMemo, useSyncExternalStore } from 'react'
import { tick } from './util'

export type FieldModelProps<T> = {
  model: FieldModel<T>
}

export type FieldModel<T> = {
  value: T
  onUpdate: (newValue: T) => void
}

declare module '@falcondev-oss/form-core' {
  interface FormFieldExtend<T> {
    model: FieldModel<T>
    [tick]: number
  }
}

/** A minimal external store surfaced to React via `useSyncExternalStore`. */
function createNotifier() {
  let version = 0
  const listeners = new Set<() => void>()
  return {
    notify: () => {
      version++
      for (const l of listeners) l()
    },
    subscribe: (cb: () => void) => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    getSnapshot: () => version,
  }
}

/** Owned Solid effect that runs `onSettle` whenever the tracked reads change. */
function subscribeEffect(owner: Owner | null, track: () => void, onSettle: () => void) {
  const run = () =>
    createEffect(
      () => {
        track()
      },
      () => onSettle(),
      { defer: true },
    )
  if (owner) runWithOwner(owner, run)
  else run()
}

export function useForm<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
>(opts: FormOptions<Schema, SourceValues>): ReturnType<typeof useFormCore<Schema, SourceValues>> {
  const inst = useMemo(() => {
    let owner: Owner | null = null
    const disposeOwner = createRoot((dispose) => {
      owner = getOwner()
      return dispose
    })
    const notifier = createNotifier()

    const readSource = () =>
      typeof opts.sourceValues === 'function' ? opts.sourceValues() : opts.sourceValues
    const [sourceValues, setSourceValues] = createSignal(readSource() as never)
    const submitRef = { current: opts.submit }

    const form = useFormCore<Schema, SourceValues>({
      ...opts,
      submit: async (...args) => submitRef.current(...args),
      sourceValues,
      [extend]: {
        $use: (field) => {
          let tickValue = 0
          subscribeEffect(
            owner,
            () => {
              void field.value
              void field.errors
            },
            () => {
              tickValue = Date.now()
              notifier.notify()
            },
          )
          Object.defineProperty(field, tick, { configurable: true, get: () => tickValue })

          return {
            model: {
              get value() {
                return field.value
              },
              onUpdate: (newValue: Parameters<typeof field.handleChange>[0]) => {
                field.handleChange(newValue)
                flush() // surface the write synchronously for React
              },
            },
            // [tick] is installed as a live getter via defineProperty above
          } as never
        },
      },
    })

    subscribeEffect(
      owner,
      () => {
        void form.errors
        void form.isLoading
        void form.isChanged
        void form.isDirty
      },
      () => notifier.notify(),
    )

    return { form, notifier, setSourceValues, submitRef, disposeOwner }
  }, [])

  useSyncExternalStore(inst.notifier.subscribe, inst.notifier.getSnapshot)

  useEffect(() => () => inst.disposeOwner(), [inst])

  useEffect(() => {
    inst.submitRef.current = opts.submit
  }, [inst, opts.submit])

  useEffect(() => {
    if (typeof opts.sourceValues === 'function') return
    inst.setSourceValues(() => opts.sourceValues as never)
    flush()
  }, [inst, opts.sourceValues])

  return inst.form
}

export function useField<T>(field: FormField<T>) {
  const inst = useMemo(() => {
    let owner: Owner | null = null
    const disposeOwner = createRoot((dispose) => {
      owner = getOwner()
      return dispose
    })
    const notifier = createNotifier()
    subscribeEffect(
      owner,
      () => {
        void field.value
        void field.errors
      },
      () => notifier.notify(),
    )
    return { notifier, disposeOwner }
  }, [field])

  useSyncExternalStore(inst.notifier.subscribe, inst.notifier.getSnapshot)
  useEffect(() => () => inst.disposeOwner(), [inst])

  return field
}

export function FormFieldMemo<T, P extends object>(
  component: FunctionComponent<P & FormFieldProps<T>>,
): NamedExoticComponent<P & FormFieldProps<T>> {
  return memo(component, (prev, next) => prev.field[tick] === next.field[tick])
}

export type {
  FormField,
  FormFieldProps,
  FormFields,
  FormFieldTranslator,
  FormHandle,
  NullableDeep,
} from '@falcondev-oss/form-core'
