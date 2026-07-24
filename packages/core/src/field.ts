import type { Owner } from '@solidjs/signals'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Hookable } from 'hookable'
import type { JsonSchema } from 'json-schema-library'
import type {
  FormFieldContext,
  FormFieldInternal,
  FormFieldTranslator,
  FormHookDefinitions,
  FormOptions,
  FormSchema,
} from './types'
import { createMemo, createSignal, flush, runWithOwner, untrack } from '@solidjs/signals'
import { isDeepEqual } from 'remeda'
import { getSchemaMeta } from './schema-meta'
import { extend, setContext } from './types'
import { getProperty, pathSegmentsToPathString } from './util'

export type PathSegment = string | number

/**
 * How a field is anchored to the reactive store.
 * - `node`: a reference node (object/array). Identity travels with the datum across
 *   reorder/splice/sort — the field is cached by the store node itself.
 * - `leaf`: a primitive value living on a parent reference node, keyed by property
 *   (stable for objects, positional index for arrays — the accepted hybrid limit).
 * - `fallback`: value/parent don't exist yet (pending); keyed positionally by path.
 */
export type FieldResolution =
  | { kind: 'node'; node: object }
  | { kind: 'leaf'; parent: object; key: PathSegment }
  | { kind: 'fallback'; segments: PathSegment[] }

export type FieldEnv = {
  hooks: Hookable<FormHookDefinitions<FormSchema>>
  opts: FormOptions<FormSchema>
  jsonSchema: JsonSchema | undefined
  owner: Owner | null

  disabled: () => boolean
  isPending: () => boolean
  isLoading: () => boolean
  sourceValues: () => object | undefined
  snapshotData: () => object
  formError: () => StandardSchemaV1.FailureResult | undefined
  liveFields: Set<FormField<unknown, FormSchema>>

  /** Current path segments of a live reference node (identity-correct across reorder). */
  segmentsOfNode: (node: object) => PathSegment[]
  /** Reactive read of the value at `segments` from the store root. */
  readAt: (segments: PathSegment[]) => unknown
  /** Route a write into the store setter (batched). */
  write: (segments: PathSegment[], value: unknown) => void
  bumpUpdateCount: () => void
  /** Whole-form validation (after the pending batch is flushed). */
  validate: () => Promise<unknown>
}

let nextKey = 0

function accessor(get: () => unknown, set?: (v: unknown) => void): PropertyDescriptor {
  return { enumerable: true, configurable: true, get, set }
}

export type FieldOpts = { discriminator?: string }

function filterFieldIssues(fieldPath: string, claimedPaths: Set<string>) {
  return (issue: StandardSchemaV1.Issue): boolean => {
    if (!issue.path) return false
    const issuePath = pathSegmentsToPathString(issue.path)

    // direct field issues
    if (issuePath === fieldPath) return true

    // nested issues, but only if no other field owns that exact path
    return issuePath.startsWith(fieldPath) && !claimedPaths.has(issuePath)
  }
}

export class FormField<T, Schema extends FormSchema> {
  #env: FieldEnv
  #resolution: FieldResolution

  #validationError = createSignal<StandardSchemaV1.FailureResult | undefined>(undefined)
  #updateCount = createSignal(0)
  #errors: () => string[] | undefined

  api: FormFieldInternal<T>

  readonly key: string

  constructor(env: FieldEnv, resolution: FieldResolution, opts?: FieldOpts) {
    this.#env = env
    this.#resolution = resolution
    this.key = `field-${nextKey++}`

    env.liveFields.add(this as FormField<unknown, Schema>)

    const owned = <R>(fn: () => R): R => (env.owner ? runWithOwner(env.owner, fn) : fn())

    this.#errors = owned(() =>
      createMemo(() => {
        if (env.isLoading()) return
        const err = this.#validationError[0]()
        return err && err.issues.length > 0 ? err.issues.map((i) => i.message) : undefined
      }),
    )

    const schemaMeta = owned(() =>
      createMemo(() =>
        env.jsonSchema ? getSchemaMeta(env.jsonSchema, env.snapshotData(), this.path, opts) : {},
      ),
    )

    const api = {
      handleChange: this.#handleChange.bind(this),
      handleBlur: this.#handleBlur.bind(this),
      reset: this.#reset.bind(this),
      key: this.key,
      [setContext]: this.#setContext.bind(this),
    }
    // Arrow getters close over the FormField instance (no `this` aliasing) and
    // read Solid state lazily, so consumer reads track and stay current.
    Object.defineProperties(api, {
      disabled: accessor(() => env.disabled()),
      errors: accessor(() => this.#errors()),
      schema: accessor(() => schemaMeta()),
      isChanged: accessor(() => !isDeepEqual<unknown>(this.value, this.#sourceValue)),
      isDirty: accessor(() => this.#updateCount[0]() !== 0),
      isPending: accessor(() => env.isPending()),
      value: accessor(
        () => this.value,
        () => console.warn('useForm:', 'field.value is readonly, use handleChange() instead'),
      ),
      path: accessor(() => this.path),
    })
    this.api = api as unknown as FormFieldInternal<T>
  }

  /** Identity-correct current path segments. */
  get segments(): PathSegment[] {
    const res = this.#resolution
    if (res.kind === 'node') return this.#env.segmentsOfNode(res.node)
    if (res.kind === 'leaf') return [...this.#env.segmentsOfNode(res.parent), res.key]
    return res.segments
  }

  get path(): string {
    return pathSegmentsToPathString(this.segments)
  }

  get value(): T {
    return this.#env.readAt(this.segments) as T
  }

  get #sourceValue(): T {
    return getProperty(this.#env.sourceValues(), this.path, null) as T
  }

  /** Called by `validate()` to distribute filtered issues to this field. */
  setValidationError(
    result: StandardSchemaV1.FailureResult | undefined,
    claimedPaths: Set<string>,
  ) {
    if (!result) {
      this.#validationError[1](undefined)
      return
    }
    this.#validationError[1]({
      issues: result.issues.filter(filterFieldIssues(this.path, claimedPaths)),
    })
  }

  #handleChange(value: T) {
    if (this.#env.disabled()) {
      console.warn('useForm:', 'handleChange() was blocked on a disabled field', `(${this.path})`)
      return
    }

    void this.#env.hooks.callHook(
      'beforeFieldChange',
      this.api as FormFieldInternal<unknown>,
      value,
    )

    this.#env.write(this.segments, value)
    this.#updateCount[1]((c) => c + 1)
    this.#env.bumpUpdateCount()

    void this.#env.hooks.callHook('afterFieldChange', this.api as FormFieldInternal<unknown>, value)
  }

  #handleBlur() {
    if (this.#env.disabled()) {
      console.warn('useForm:', 'handleBlur() was blocked on a disabled field', `(${this.path})`)
      return
    }
    // commit any pending edits so the edit-count and data are current
    flush()
    if (untrack(() => this.#updateCount[0]()) === 0) return
    void this.#env.validate()
  }

  #reset() {
    if (this.#env.disabled()) {
      console.warn('useForm:', 'reset() was blocked on a disabled field', `(${this.path})`)
      return
    }
    this.#updateCount[1](0)
    this.#env.write(this.segments, this.#sourceValue)
    this.#validationError[1](undefined)
  }

  #setContext(_ctx: FormFieldContext<T>) {
    // path is derived from engine identity now; nothing to store.
  }

  markPristine() {
    this.#updateCount[1](0)
  }

  translatedApi<TT extends T, O>(translator: FormFieldTranslator<TT, O>) {
    const extendFieldFn = this.#env.opts[extend]?.$use
    // Preserve the live getters from `api` (spreading would snapshot them),
    // overriding only value/handleChange for the translation.
    const translatedField = Object.create(
      Object.getPrototypeOf(this.api) as object,
      Object.getOwnPropertyDescriptors(this.api),
    ) as FormFieldInternal<O>
    Object.defineProperty(translatedField, 'value', {
      configurable: true,
      enumerable: true,
      get: () => translator.get(this.value as TT),
    })
    translatedField.handleChange = (value: O) => this.api.handleChange(translator.set(value))

    if (extendFieldFn) {
      Object.assign(translatedField, extendFieldFn(translatedField as never))
    }
    return translatedField
  }
}
