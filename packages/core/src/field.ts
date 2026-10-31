import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Accessor, Owner } from '@solidjs/signals'
import type { Hookable } from 'hookable'
import type { JSONSchema } from 'json-schema-typed'
import type { FormStore, PathSegment } from './data'
import type { Location } from './location'
import type {
  BuildFormFieldAccessors,
  FormFieldExtend,
  FormFieldInternal,
  FormFieldTranslator,
  FormHookDefinitions,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from './types'
import { createMemo, createSignal, runWithOwner, untrack } from '@solidjs/signals'
import { toPlain } from './data'
import { getSchemaMeta } from './json-schema'
import { hasPendingStep, isWithin, locationId } from './location'
import { commit, observe } from './reactive'
import { extend } from './types'
import { isDeepEqual, pathSegmentsToPathString } from './util'

/** A validation issue, pinned to the item it was reported for. */
export type LocatedIssue = { issue: StandardSchemaV1.Issue; location: Location; id: string }

export type FormContext<Schema extends FormSchema> = {
  owner: Owner
  hooks: Hookable<FormHookDefinitions<Schema>>
  opts: FormOptions<Schema, FormSourceValues<Schema>>
  jsonSchema: JSONSchema.Interface | undefined
  data: FormStore
  /** The source values in stored form, sharing item keys with the data. */
  sourceStored: Accessor<unknown>
  issues: Accessor<LocatedIssue[] | undefined>
  setIssues: (issues: LocatedIssue[] | undefined) => void
  validate: () => LocatedIssue[] | undefined | Promise<LocatedIssue[] | undefined>
  /** Whether a field exists at this location id (its issues belong to it). */
  isClaimed: (id: string) => boolean
  /** A pending field found its item. */
  rebind: (field: FormField<unknown>, previousId: string, nextId: string) => void
  accessor: (segments: PathSegment[]) => BuildFormFieldAccessors<any>
  /** Call inside `commit()`. */
  markEdited: () => void
  isDirty: Accessor<boolean>
  isDisabled: Accessor<boolean>
  isPending: Accessor<boolean>
}

/** Copies own properties as descriptors, so getters and setters stay live. */
export function assignDescriptors<T extends object>(target: T, source: object | undefined) {
  if (source) Object.defineProperties(target, Object.getOwnPropertyDescriptors(source))
  return target
}

export type FormField<T> = ReturnType<typeof createFormField<T, FormSchema>>

/**
 * Creates a field's reactive state. Run it under the form's owner. The field
 * is bound to its location: inside arrays that is the item, not the index.
 */
export function createFormField<T, Schema extends FormSchema>(
  initialLocation: Location,
  form: FormContext<Schema>,
) {
  const [location, setLocation] = createSignal<Location>(initialLocation, { ownedWrite: true })
  const id = createMemo(() => locationId(location()))
  const resolved = createMemo(() => form.data.resolve(location()))
  const isDetached = createMemo(() => resolved() === undefined)
  // a detached field keeps showing where and what its item was
  const segments = createMemo<PathSegment[]>((prev) => resolved()?.segments ?? prev ?? [])
  const path = createMemo(() => pathSegmentsToPathString(segments()))
  const value = createMemo<T>((prev) => {
    const current = resolved()
    if (!current) return (prev ?? null) as T
    return (form.data.present(location(), current.node) ?? null) as T
  })

  const plainValue = createMemo(() => toPlain(resolved()?.node) ?? null)
  // an item compares with its own source value, wherever it moved; new items have none
  const sourceValue = createMemo(
    () => toPlain(form.data.resolveIn(form.sourceStored(), location())?.node) ?? null,
  )
  const isChanged = createMemo(() => !isDeepEqual(plainValue(), sourceValue()))

  // writable memo: back to 0 when the form becomes pristine, otherwise keeps counting
  const [updateCount, setUpdateCount] = createSignal<number>((prev) =>
    form.isDirty() ? (prev ?? 0) : 0,
  )
  const isDirty = createMemo(() => updateCount() !== 0)

  const owns = (issue: LocatedIssue) =>
    issue.id === id() || (isWithin(issue.id, id()) && !form.isClaimed(issue.id))
  // writable memo: follows form-wide validation, `validate()` overwrites it for this field only
  const [issues, setIssues] = createSignal<LocatedIssue[] | undefined>(() =>
    form.issues()?.filter(owns),
  )
  const errors = createMemo(() => {
    const current = issues()
    return current && current.length > 0 ? current.map((i) => i.issue.message) : undefined
  })

  const schema = createMemo(() =>
    form.jsonSchema ? getSchemaMeta(form.jsonSchema, form.data.root() as object, path()) : {},
  )

  async function validate() {
    const formIssues = await form.validate()
    if (!formIssues) {
      commit(() => {
        form.setIssues(undefined)
        setIssues(undefined)
      })
      return
    }
    commit(() => setIssues(untrack(() => formIssues.filter(owns))))
  }

  function blocked(action: string) {
    if (untrack(form.isDisabled)) {
      console.warn('useForm:', `${action} was blocked on a disabled field`, `(${untrack(path)})`)
      return true
    }
    return false
  }

  function handleChange(newValue: T) {
    if (blocked('handleChange()')) return
    const current = untrack(resolved)
    if (!current) {
      console.warn(
        'useForm:',
        'handleChange() was ignored, the array item of this field was removed',
        `(${untrack(path)})`,
      )
      return
    }

    void form.hooks.callHook('beforeFieldChange', api as FormFieldInternal<unknown>, newValue)

    commit(() => {
      form.data.write(current.segments, newValue)
      setUpdateCount((c) => c + 1)
      form.markEdited()
    })

    void form.hooks.callHook('afterFieldChange', api as FormFieldInternal<unknown>, newValue)

    if (untrack(errors)) void validate()
  }

  function handleBlur() {
    if (blocked('handleBlur()')) return
    // blur after the row was removed: nothing left to validate
    if (untrack(isDetached) || untrack(updateCount) === 0) return

    void validate()
  }

  function reset() {
    if (blocked('reset()')) return
    const current = untrack(resolved)
    if (!current) return

    // the source's stored form carries the item keys, so moved items return to their places
    const source = untrack(() => form.data.resolveIn(form.sourceStored(), location())?.node)
    commit(() => {
      setUpdateCount(0)
      form.data.writeStored(current.segments, source ?? null)
      setIssues(undefined)
    })
  }

  function warnReadonly() {
    console.warn(
      'useForm:',
      'field.value is readonly, use field.handleChange() instead',
      `(${untrack(path)})`,
    )
  }

  const api = {
    get disabled() {
      return form.isDisabled()
    },
    get errors() {
      return errors()
    },
    get schema() {
      return schema()
    },
    handleChange,
    handleBlur,
    reset,
    get isChanged() {
      return isChanged()
    },
    get isDirty() {
      return isDirty()
    },
    get isPending() {
      return form.isPending()
    },
    get isDetached() {
      return isDetached()
    },
    get value() {
      return value()
    },
    set value(_: T) {
      warnReadonly()
    },
    get path() {
      return path()
    },
    key: `${pathSegmentsToPathString(untrack(segments))}@${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: 'numeric', fractionalSecondDigits: 2, hour12: false })}-${Math.random()
      .toString(36)
      .slice(2)}`,
    $: () => form.accessor(untrack(segments)),
  } satisfies FormFieldInternal<T>

  /** A view of the field that reads and writes through `translator`; shares all other state. */
  function translated<O>(translator: FormFieldTranslator<T, O>) {
    return runWithOwner(form.owner, () => {
      const translatedValue = createMemo(() => translator.get(value()))
      const view = assignDescriptors({}, api) as unknown as FormFieldInternal<O>
      Object.defineProperties(view, {
        value: {
          get: () => translatedValue(),
          set: warnReadonly,
          enumerable: true,
          configurable: true,
        },
        handleChange: {
          value: (v: O) => handleChange(translator.set(v)),
          enumerable: true,
          configurable: true,
          writable: true,
        },
      })
      return assignDescriptors(view, form.opts[extend]?.$use?.(view))
    })
  }

  const field = {
    api: api as typeof api & Partial<FormFieldExtend<T>>,
    location,
    segments,
    validate,
    translated,
  }

  // created before its item exists: binds to the first item that appears at its position
  if (hasPendingStep(initialLocation)) {
    const stop = observe(
      () => form.data.locate(form.data.resolve(location())?.segments ?? []),
      () => {
        const current = location()
        const next = form.data.resolve(current)
        if (!next) return
        const bound = form.data.locate(next.segments)
        if (locationId(bound) === locationId(current)) return

        setLocation(bound)
        form.rebind(field as FormField<unknown>, locationId(current), locationId(bound))
        if (!hasPendingStep(bound)) stop()
      },
    )
  }

  return field
}
