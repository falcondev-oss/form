import type { StandardSchemaV1 } from '@standard-schema/spec'
import type {
  FormFieldInternal,
  FormFieldTranslator,
  FormSchema,
  FormOptions,
  FormSourceValues,
  SchemaMeta,
} from './types'
import { createSignal } from '@solidjs/signals'
import { isDeepEqual } from 'remeda'
import { extend } from './types'

export type FieldBinding = {
  value: () => unknown
  source: () => unknown
  path: () => string | undefined
  write: (value: unknown) => void
}

export type FieldForm<Schema extends FormSchema> = {
  opts: FormOptions<Schema, FormSourceValues<Schema>>
  disabled: () => boolean
  pending: () => boolean
  loading: () => boolean
  schema: (path: string) => SchemaMeta
  validate: (field: FormField<Schema>) => Promise<StandardSchemaV1.Result<unknown>>
  change: (field: FormFieldInternal<unknown>, value: unknown, write: () => void) => void
  extend: <T>(field: FormFieldInternal<T>) => void
}

let nextKey = 0

export class FormField<Schema extends FormSchema> {
  readonly binding: FieldBinding
  api: FormFieldInternal<unknown>
  readonly errors = createSignal<string[] | undefined>(undefined)
  readonly dirty = createSignal(false)

  constructor(binding: FieldBinding, form: FieldForm<Schema>) {
    this.binding = binding
    const { errors, dirty } = this
    this.api = {
      get value() {
        return binding.value() ?? null
      },
      get path() {
        return binding.path() ?? ''
      },
      key: `field-${++nextKey}`,
      get errors() {
        return form.loading() ? undefined : errors[0]()
      },
      get isDirty() {
        return dirty[0]()
      },
      get isChanged() {
        return !isDeepEqual(binding.value(), binding.source())
      },
      get disabled() {
        return form.disabled()
      },
      get isPending() {
        return form.pending()
      },
      get schema() {
        return form.schema(binding.path() ?? '')
      },
      handleChange: (value) => {
        if (form.disabled() || binding.path() === undefined) return
        dirty[1](true)
        form.change(this.api, value, () => binding.write(value))
      },
      handleBlur: () => {
        if (!form.disabled() && dirty[0]()) void form.validate(this)
      },
      reset: () => {
        if (form.disabled()) return
        binding.write(binding.source())
        this.clear()
      },
    }
  }

  clear() {
    this.dirty[1](false)
    this.errors[1](undefined)
  }

  translatedApi<O>(translator: FormFieldTranslator<unknown, O>, form: FieldForm<Schema>) {
    const api = Object.create(
      Object.getPrototypeOf(this.api),
      Object.getOwnPropertyDescriptors(this.api),
    ) as FormFieldInternal<O>
    Object.defineProperties(api, {
      value: { configurable: true, enumerable: true, get: () => translator.get(this.api.value) },
      handleChange: {
        configurable: true,
        enumerable: true,
        value: (value: O) => this.api.handleChange(translator.set(value)),
      },
    })
    form.extend(api)
    return form.opts[extend]?.wrap?.(api) ?? api
  }
}
