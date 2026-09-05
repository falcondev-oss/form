import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Accessor } from '@solidjs/signals'
import type { Hookable } from 'hookable'
import type { JSONSchema } from 'json-schema-typed'
import type {
  FormFieldInternal,
  FormFieldTranslator,
  FormHookDefinitions,
  FormOptions,
  FormSchema,
  FormSourceValues,
} from './types'
import { createEffect, createMemo, createSignal, deep } from '@solidjs/signals'
import { isDeepEqual } from 'remeda'
import { getSchemaMeta } from './json-schema'
import { extend } from './types'
import { getProperty, pathSegmentsToPathString } from './util'

/**
 * One step from the form root to a field. `{ el }` is an array element resolved by identity
 * (the store proxy of the element object), so the field follows its datum when the array is reordered.
 * Plain keys are positional: object properties and primitive array elements.
 */
export type Segment = string | number | { el: object }

export type Location = {
  /** one entry per resolved segment: the node holding the slot (undefined if missing) and the slot */
  steps: { parent: object | undefined; key: string | number; value: unknown }[]
  value: unknown
  /** an element segment whose element left its array */
  detached: boolean
}

export type Form<Schema extends FormSchema> = {
  hooks: Hookable<FormHookDefinitions<Schema>>
  opts: FormOptions<Schema, FormSourceValues<Schema>>
  jsonSchema: JSONSchema.Interface | undefined
  data: Accessor<object>
  resolve: (segments: Segment[]) => Location
  write: (segments: Segment[], value: unknown) => void
  hasField: (path: readonly (PropertyKey | StandardSchemaV1.PathSegment)[]) => boolean
  facade: (value: unknown) => unknown
  accessor: (segments: Segment[]) => unknown
  validate: () => Promise<StandardSchemaV1.Result<unknown>>
  disabled: Accessor<boolean>
  isPending: Accessor<boolean>
  isPristine: Accessor<boolean>
  error: Accessor<StandardSchemaV1.FailureResult | undefined>
  setError: (error: StandardSchemaV1.FailureResult | undefined) => void
  sourceValues: Accessor<object | undefined>
  markDirty: () => void
  track: (scope: object) => void
  notify: (scope: object) => void
}

// never equals a real path, so a detached field matches no issue and no source value
const DETACHED_PATH = '~detached'

let keyCounter = 0

export class FormField<T, Schema extends FormSchema> {
  #form: Form<Schema>
  readonly segments: Segment[]

  #validationError: Accessor<StandardSchemaV1.FailureResult | undefined>
  #setValidationError: (error: StandardSchemaV1.FailureResult | undefined) => void
  #isDirty: Accessor<boolean>
  #setIsDirty: (isDirty: boolean) => void

  #value: Accessor<T>
  #path: Accessor<string>
  #sourceValue: Accessor<T>
  #errors: Accessor<string[] | undefined>
  #isChanged: Accessor<boolean>
  #schema: Accessor<ReturnType<typeof getSchemaMeta>>

  api: FormFieldInternal<T>

  #filterIssues(issue: StandardSchemaV1.Issue) {
    if (!issue.path) return false
    const fieldPath = this.#path()
    const issuePath = pathSegmentsToPathString(issue.path)
    if (issuePath === fieldPath) return true

    // nested issues are only reported here if no field is bound to their own path
    const isNested =
      fieldPath === '' ||
      issuePath.startsWith(`${fieldPath}.`) ||
      issuePath.startsWith(`${fieldPath}[`)
    return isNested && !this.#form.hasField(issue.path)
  }

  async validate() {
    const result = await this.#form.validate()
    if (!result.issues) {
      this.#setValidationError(undefined)
      // clears the other fields through the form error effect
      this.#form.setError(undefined)
      return
    }

    this.#setValidationError({ issues: result.issues.filter((i) => this.#filterIssues(i)) })
  }

  #guard(action: string) {
    if (!this.#form.disabled()) return true
    console.warn('useForm:', `${action} was blocked on a disabled field`, `(${this.#path()})`)
    return false
  }

  #handleChange(value: T) {
    if (!this.#guard('handleChange()')) return

    void this.#form.hooks.callHook(
      'beforeFieldChange',
      this.api as FormFieldInternal<unknown>,
      value,
    )

    this.#form.write(this.segments, value)
    this.#setIsDirty(true)
    this.#form.markDirty()

    void this.#form.hooks.callHook(
      'afterFieldChange',
      this.api as FormFieldInternal<unknown>,
      value,
    )

    void this.validate()
  }

  #handleBlur() {
    if (!this.#guard('handleBlur()')) return
    if (!this.#isDirty()) return

    void this.validate()
  }

  #reset() {
    if (!this.#guard('reset()')) return

    this.#setIsDirty(false)
    this.#form.write(this.segments, this.#sourceValue())
    this.#setValidationError(undefined)
  }

  constructor(segments: Segment[], form: Form<Schema>) {
    this.#form = form
    this.segments = segments
    ;[this.#validationError, this.#setValidationError] = createSignal()
    ;[this.#isDirty, this.#setIsDirty] = createSignal(false)

    const location = createMemo(() => form.resolve(segments))
    this.#value = createMemo(() => (location().value ?? null) as T)
    this.#path = createMemo(() => {
      const { steps, detached } = location()
      return detached ? DETACHED_PATH : pathSegmentsToPathString(steps.map((step) => step.key))
    })
    this.#sourceValue = createMemo(
      () => (getProperty(form.sourceValues(), this.#path(), null) ?? null) as T,
    )
    this.#errors = createMemo(() => {
      const issues = this.#validationError()?.issues
      return issues && issues.length > 0 ? issues.map((i) => i.message) : undefined
    })
    this.#isChanged = createMemo(
      () => !isDeepEqual<unknown>(deep(this.#value()), this.#sourceValue()),
    )
    this.#schema = createMemo(() =>
      form.jsonSchema ? getSchemaMeta(form.jsonSchema, form.data(), this.#path()) : {},
    )

    // form-wide validation distributes its issues to every field
    createEffect(
      () => form.error(),
      (error) => {
        this.#setValidationError(
          error ? { issues: error.issues.filter((i) => this.#filterIssues(i)) } : undefined,
        )
      },
      { defer: true },
    )
    createEffect(
      () => form.isPristine(),
      (isPristine) => {
        if (isPristine) this.#setIsDirty(false)
      },
      { defer: true },
    )

    const errors = this.#errors
    const schema = this.#schema
    const isChanged = this.#isChanged
    const isDirty = this.#isDirty
    const value = this.#value
    const path = this.#path
    const track = () => form.track(api)
    const api: FormFieldInternal<T> = {
      get disabled() {
        track()
        return form.disabled()
      },
      get errors() {
        track()
        return errors()
      },
      get schema() {
        track()
        return schema()
      },
      handleChange: this.#handleChange.bind(this),
      handleBlur: this.#handleBlur.bind(this),
      reset: this.#reset.bind(this),
      get isChanged() {
        track()
        return isChanged()
      },
      get isDirty() {
        track()
        return isDirty()
      },
      get isPending() {
        track()
        return form.isPending()
      },
      get value() {
        track()
        return form.facade(value()) as T
      },
      get path() {
        track()
        return path()
      },
      key: `field:${++keyCounter}`,
      $: () => form.accessor(segments) as ReturnType<NonNullable<FormFieldInternal<T>['$']>>,
    }
    this.api = api

    // one notification per flush for anything readable through the api
    createEffect(
      () => {
        deep(value())
        errors()
        schema()
        isChanged()
        isDirty()
        path()
        form.disabled()
        form.isPending()
      },
      () => {
        form.notify(api)
      },
      { defer: true },
    )

    Object.defineProperties(
      api,
      Object.getOwnPropertyDescriptors(form.opts[extend]?.$use?.(api, api) ?? {}),
    )
  }

  translatedApi<TT extends T, O>(translator: FormFieldTranslator<TT, O>) {
    const api = this.api
    const translatedApi = Object.defineProperties({} as FormFieldInternal<O>, {
      ...Object.getOwnPropertyDescriptors(api),
      value: { get: () => translator.get(api.value as TT), enumerable: true, configurable: true },
      handleChange: {
        value: (value: O) => api.handleChange(translator.set(value)),
        enumerable: true,
        configurable: true,
      },
    })

    Object.defineProperties(
      translatedApi,
      Object.getOwnPropertyDescriptors(this.#form.opts[extend]?.$use?.(translatedApi, api) ?? {}),
    )

    return translatedApi
  }
}
