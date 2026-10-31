import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Accessor, Owner } from '@solidjs/signals'
import type { Hookable } from 'hookable'
import type { JSONSchema } from 'json-schema-typed'
import type { FieldCache } from './field-cache'
import type { FormStore } from './data'
import type {
  FormFieldContext,
  FormFieldExtend,
  FormFieldInternal,
  FormFieldTranslator,
  FormHookDefinitions,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from './types'
import { createMemo, createSignal, runWithOwner, untrack } from '@solidjs/signals'
import { klona } from 'klona/full'
import { getIn, toSegments } from './data'
import { deleteCacheItem } from './field-cache'
import { getSchemaMeta } from './json-schema'
import { commit } from './reactive'
import { extend, setContext } from './types'
import { getProperty, isDeepEqual, pathSegmentsToPathString } from './util'

export type FormContext<Schema extends FormSchema> = {
  owner: Owner
  hooks: Hookable<FormHookDefinitions<Schema>>
  opts: FormOptions<Schema, FormSourceValues<Schema>>
  jsonSchema: JSONSchema.Interface | undefined
  fieldCache: FieldCache
  data: FormStore
  sourceValues: Accessor<object | undefined>
  formError: Accessor<StandardSchemaV1.FailureResult | undefined>
  setFormError: (error: StandardSchemaV1.FailureResult | undefined) => void
  /** Call inside `commit()`. */
  markEdited: () => void
  isDirty: Accessor<boolean>
  isDisabled: Accessor<boolean>
  isPending: Accessor<boolean>
}

function filterFieldIssues(fieldPath: string, fieldCache: FieldCache) {
  return (issue: StandardSchemaV1.Issue): boolean => {
    if (!issue.path) return false
    const issuePath = pathSegmentsToPathString(issue.path)

    // direct field issues
    if (issuePath === fieldPath) return true

    // only include nested issues for fields are not connected
    return issuePath.startsWith(fieldPath) && !getProperty(fieldCache, issuePath)?.$field
  }
}

/** Copies own properties as descriptors, so getters and setters stay live. */
export function assignDescriptors<T extends object>(target: T, source: object | undefined) {
  if (source) Object.defineProperties(target, Object.getOwnPropertyDescriptors(source))
  return target
}

function warnBlocked(action: string, path: string) {
  console.warn('useForm:', `${action} was blocked on a disabled field`, `(${path})`)
}

export type FormField<T> = ReturnType<typeof createFormField<T, FormSchema>>

/** Creates a field's reactive state. Run it under the form's owner. */
export function createFormField<T, Schema extends FormSchema>(
  initialPath: string,
  form: FormContext<Schema>,
) {
  // a cached field moves to a new path when array items shift
  const [path, setPath] = createSignal(initialPath, { ownedWrite: true })
  const segments = createMemo(() => toSegments(path()))

  const value = createMemo(() => (form.data.get(segments()) ?? null) as T)
  const sourceValue = createMemo(() => (getIn(form.sourceValues(), segments()) ?? null) as T)

  // writable memo: back to 0 when the form becomes pristine, otherwise keeps counting
  const [updateCount, setUpdateCount] = createSignal<number>((prev) =>
    form.isDirty() ? (prev ?? 0) : 0,
  )
  const isDirty = createMemo(() => updateCount() !== 0)

  // writable memo: follows form-wide validation, `validate()` overwrites it for this field only
  const [validationError, setValidationError] = createSignal<
    StandardSchemaV1.FailureResult | undefined
  >(() => {
    const error = form.formError()
    return error
      ? { issues: error.issues.filter(filterFieldIssues(path(), form.fieldCache)) }
      : undefined
  })
  const errors = createMemo(() => {
    const issues = validationError()?.issues
    return issues && issues.length > 0 ? issues.map((i) => i.message) : undefined
  })

  const isChanged = createMemo(() => !isDeepEqual(value(), sourceValue()))
  const schema = createMemo(() =>
    form.jsonSchema ? getSchemaMeta(form.jsonSchema, form.data.state, path()) : {},
  )

  async function validate() {
    const result = await Promise.resolve(
      form.opts.schema['~standard'].validate(form.data.snapshot()),
    )
    if (!result.issues) {
      commit(() => {
        form.setFormError(undefined)
        setValidationError(undefined)
      })
      return
    }

    const issues = result.issues.filter(filterFieldIssues(untrack(path), form.fieldCache))
    commit(() => setValidationError({ issues }))
  }

  function handleChange(newValue: T) {
    const currentPath = untrack(path)
    if (untrack(form.isDisabled)) return warnBlocked('handleChange()', currentPath)

    void form.hooks.callHook('beforeFieldChange', api as FormFieldInternal<unknown>, newValue)

    commit(() => {
      form.data.set(currentPath, newValue)
      // a replaced array gets fresh item keys
      if (Array.isArray(newValue)) deleteCacheItem(form.fieldCache, currentPath)
      setUpdateCount((c) => c + 1)
      form.markEdited()
    })

    void form.hooks.callHook('afterFieldChange', api as FormFieldInternal<unknown>, newValue)

    if (untrack(errors)) void validate()
  }

  function handleBlur() {
    if (untrack(form.isDisabled)) return warnBlocked('handleBlur()', untrack(path))
    if (untrack(updateCount) === 0) return

    void validate()
  }

  function reset() {
    const currentPath = untrack(path)
    if (untrack(form.isDisabled)) return warnBlocked('reset()', currentPath)

    commit(() => {
      setUpdateCount(0)
      form.data.set(currentPath, klona(untrack(sourceValue)))
      setValidationError(undefined)
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
    get value() {
      return value()
    },
    set value(_: T) {
      warnReadonly()
    },
    get path() {
      return path()
    },
    key: `${initialPath}@${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: 'numeric', fractionalSecondDigits: 2, hour12: false })}-${Math.random()
      .toString(36)
      .slice(2)}`,
    [setContext](ctx: FormFieldContext<T>) {
      if (ctx.path !== untrack(path)) commit(() => setPath(ctx.path))
    },
  } satisfies Omit<FormFieldInternal<T>, '$'>

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

  return { api: api as typeof api & Partial<FormFieldExtend<T>>, validate, translated }
}
