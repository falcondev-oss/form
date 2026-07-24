import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Hookable } from 'hookable'
import type {
  BuildFormFieldAccessors,
  FormFieldInternal,
  FormFieldTranslator,
  FormHookDefinitions,
  FormSchema,
  SchemaMeta,
} from './types'
import { isDeepEqual } from 'remeda'
import { setContext } from './types'

export type FieldOpts = { discriminator?: string }

export type FieldBinding =
  | { kind: 'reference'; value: object }
  | { kind: 'leaf'; parent: object; key: PropertyKey }
  | { kind: 'path'; segments: PropertyKey[] }

export type FormInternal = {
  flush: () => void
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => number
}

export type FormRuntime<Schema extends FormSchema> = {
  hooks: Hookable<FormHookDefinitions<Schema>>
  track: () => void
  disabled: () => boolean
  isPending: () => boolean
  read: (binding: FieldBinding) => unknown
  write: (binding: FieldBinding, value: unknown) => void
  source: (binding: FieldBinding) => unknown
  path: (binding: FieldBinding) => string
  facade: <T>(value: T) => T
  validate: () => Promise<unknown>
  issues: (path: string) => StandardSchemaV1.Issue[]
  schemaMeta: (path: string, opts?: FieldOpts) => SchemaMeta
  notifyFieldStateChange: () => void
  internal: FormInternal
}

let nextFieldKey = 0

export class FormField<T, Schema extends FormSchema> {
  readonly binding: FieldBinding
  readonly api: FormFieldInternal<T>

  #form: FormRuntime<Schema>
  #state = { updateCount: 0 }

  constructor(binding: FieldBinding, form: FormRuntime<Schema>, opts?: FieldOpts) {
    this.binding = binding
    this.#form = form

    const key = `field-${++nextFieldKey}`
    const state = this.#state
    const api = {
      get disabled() {
        form.track()
        return form.disabled()
      },
      get errors() {
        form.track()
        const errors = form.issues(form.path(binding)).map((issue) => issue.message)
        return errors.length > 0 ? errors : undefined
      },
      get schema() {
        form.track()
        return form.schemaMeta(form.path(binding), opts)
      },
      handleChange: this.#handleChange.bind(this),
      handleBlur: this.#handleBlur.bind(this),
      reset: this.#reset.bind(this),
      get isChanged() {
        form.track()
        return !isDeepEqual(form.read(binding), form.source(binding))
      },
      get isDirty() {
        form.track()
        return state.updateCount !== 0
      },
      get isPending() {
        form.track()
        return form.isPending()
      },
      get value() {
        form.track()
        return form.facade(form.read(binding) ?? null) as T
      },
      get path() {
        form.track()
        return form.path(binding)
      },
      key,
      [setContext]: () => {},
    }

    Object.defineProperty(api, '~', { value: form.internal })
    this.api = api satisfies FormFieldInternal<T>
  }

  async validate() {
    return this.#form.validate()
  }

  markPristine() {
    this.#state.updateCount = 0
  }

  #handleChange(value: T) {
    const path = this.#form.path(this.binding)
    if (this.#form.disabled()) {
      console.warn('useForm:', 'handleChange() was blocked on a disabled field', `(${path})`)
      return
    }

    void this.#form.hooks.callHook(
      'beforeFieldChange',
      this.api as FormFieldInternal<unknown>,
      value,
    )
    const valueChanged = !isDeepEqual(this.#form.read(this.binding), value)
    this.#form.write(this.binding, value)
    this.#state.updateCount++
    if (!valueChanged) this.#form.notifyFieldStateChange()
    void this.#form.hooks.callHook(
      'afterFieldChange',
      this.api as FormFieldInternal<unknown>,
      value,
    )
  }

  #handleBlur() {
    if (this.#form.disabled()) {
      console.warn(
        'useForm:',
        'handleBlur() was blocked on a disabled field',
        `(${this.#form.path(this.binding)})`,
      )
      return
    }
    if (this.#state.updateCount > 0) void this.validate()
  }

  #reset() {
    if (this.#form.disabled()) {
      console.warn(
        'useForm:',
        'reset() was blocked on a disabled field',
        `(${this.#form.path(this.binding)})`,
      )
      return
    }
    const source = this.#form.source(this.binding)
    const valueChanged = !isDeepEqual(this.#form.read(this.binding), source)
    this.#form.write(this.binding, source)
    this.#state.updateCount = 0
    if (!valueChanged) this.#form.notifyFieldStateChange()
  }

  translatedApi<TT extends T, O>(translator: FormFieldTranslator<TT, O>) {
    const field = this.api
    return {
      get disabled() {
        return field.disabled
      },
      get errors() {
        return field.errors
      },
      get schema() {
        return field.schema
      },
      get value() {
        return translator.get(field.value as TT)
      },
      handleChange(value: O) {
        field.handleChange(translator.set(value))
      },
      handleBlur: field.handleBlur,
      reset: field.reset,
      get isChanged() {
        return field.isChanged
      },
      get isDirty() {
        return field.isDirty
      },
      get isPending() {
        return field.isPending
      },
      get path() {
        return field.path
      },
      key: field.key,
      $: field.$ as () => BuildFormFieldAccessors<O>,
      [setContext]: field[setContext],
    }
  }
}
