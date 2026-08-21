import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Hookable } from 'hookable'
import type { JSONSchema } from 'json-schema-typed'
import type {
  FormFieldInternal,
  FormFieldTranslator,
  FormHookDefinitions,
  FormOptions,
  FormSchema,
} from './types'
import { createEffect, createMemo, createRoot, createSignal } from '@solidjs/signals'
import { getProperty } from 'dot-prop'
import { isDeepEqual } from 'remeda'
import { getSchemaMeta } from './json-schema'
import { extend } from './types'

export type FormFieldBag<Schema extends FormSchema> = {
  hooks: Hookable<FormHookDefinitions<Schema>>
  formOpts: FormOptions<Schema, any>
  jsonSchema: JSONSchema.Interface | undefined
  path: string
  data: object
  disabled: () => boolean
  isLoading: () => boolean
  isPending: () => boolean
  version: () => number
  pristineVersion: () => number
  formError: () => StandardSchemaV1.FailureResult | undefined
  sourceSnapshot: () => object
  validateForm: () => Promise<unknown>
  deepestClaimant: (issue: StandardSchemaV1.Issue) => FormField<unknown, any> | undefined
  write: (value: unknown) => void
  /** set for reference-node fields: reset merges into the live node, keeping its identity */
  mergeWrite?: (value: unknown) => void
  /** set for reference-node fields: the stable facade of the node itself */
  valueFacade?: object
  /** set for primitive-leaf fields: read via parentFacade[key] */
  leafParent?: object
  leafKey?: string | number
}

export class FormField<T, Schema extends FormSchema> {
  #bag: FormFieldBag<Schema>
  #changeCount = createSignal(0)
  api: FormFieldInternal<T>

  constructor(bag: FormFieldBag<Schema>) {
    this.#bag = bag

    const [changeCount, setChangeCount] = this.#changeCount

    // sync per-field dirty state to form-level pristine transitions (reset / submit success)
    createRoot(() => {
      createEffect(
        () => `${bag.version()}:${bag.pristineVersion()}`,
        () => {
          if (bag.version() === bag.pristineVersion()) setChangeCount(0)
        },
      )
    })

    const sourceValue = () => getProperty(bag.sourceSnapshot(), bag.path, null) as T

    const getValue = (): T => {
      if (bag.isPending()) return null as T
      if (bag.valueFacade) return bag.valueFacade as T
      if (bag.leafParent) return ((bag.leafParent as any)?.[bag.leafKey!] ?? null) as T
      // broken identity chain: dynamic path read
      return (getProperty(bag.data, bag.path, null) ?? null) as T
    }

    const errors = createMemo(() => {
      if (bag.isLoading()) return undefined
      const error = bag.formError()
      if (!error) return undefined

      const claimed = error.issues.filter((issue) => bag.deepestClaimant(issue) === this)
      return claimed.length > 0 ? claimed.map((issue) => issue.message) : undefined
    })

    const isChanged = createMemo(() => !isDeepEqual(getValue(), sourceValue()))

    const api = {
      get disabled() {
        return bag.disabled()
      },
      get errors() {
        return errors()
      },
      get schema() {
        return bag.jsonSchema ? getSchemaMeta(bag.jsonSchema, bag.data, bag.path) : {}
      },
      handleChange: (value: T) => this.#handleChange(value),
      handleBlur: () => this.#handleBlur(),
      reset: () => this.#reset(),
      get isChanged() {
        return isChanged()
      },
      get isDirty() {
        return changeCount() !== 0
      },
      get isPending() {
        return bag.isPending()
      },
      get value(): T {
        return getValue()
      },
      path: bag.path,
      key: crypto.randomUUID(),
      // assigned by the form after construction (needs the accessor factory)
      $: (() => {
        throw new Error('not implemented')
      }) as unknown as FormFieldInternal<T>['$'],
    }

    this.api = api as FormFieldInternal<T>
  }

  get value(): T {
    return this.api.value
  }

  async validate() {
    await this.#bag.validateForm()
  }

  #handleChange(value: T) {
    const bag = this.#bag
    if (bag.disabled()) {
      console.warn('useForm:', 'handleChange() was blocked on a disabled field', `(${bag.path})`)
      return
    }
    if (bag.isPending()) return

    void bag.hooks.callHook('beforeFieldChange', this.api as FormFieldInternal<unknown>, value)

    this.#changeCount[1]((count) => count + 1)
    bag.write(value)

    void bag.hooks.callHook('afterFieldChange', this.api as FormFieldInternal<unknown>, value)

    if ((this.api.errors?.length ?? 0) > 0) void bag.validateForm()
  }

  #handleBlur() {
    const bag = this.#bag
    if (bag.disabled()) {
      console.warn('useForm:', 'handleBlur() was blocked on a disabled field', `(${bag.path})`)
      return
    }

    if (this.#changeCount[0]() === 0) return

    void bag.validateForm()
  }

  #reset() {
    const bag = this.#bag
    if (bag.disabled()) {
      console.warn('useForm:', 'reset() was blocked on a disabled field', `(${bag.path})`)
      return
    }

    this.#changeCount[1](0)
    const sourceValue = getProperty(bag.sourceSnapshot(), bag.path, null)
    if (bag.mergeWrite) {
      bag.mergeWrite(sourceValue)
    } else {
      bag.write(sourceValue)
    }
    void bag.validateForm()
  }

  translatedApi<TT extends T, O>(translator: FormFieldTranslator<TT, O>): FormFieldInternal<O> {
    const base = this.api
    const extendFieldFn = this.#bag.formOpts?.[extend]?.$use

    const translated = {
      get disabled() {
        return base.disabled
      },
      get errors() {
        return base.errors
      },
      get schema() {
        return base.schema
      },
      get isChanged() {
        return base.isChanged
      },
      get isDirty() {
        return base.isDirty
      },
      get isPending() {
        return base.isPending
      },
      get value(): O {
        return translator.get(base.value as TT)
      },
      path: base.path,
      key: base.key,
      handleChange: (value: O) => base.handleChange(translator.set(value)),
      handleBlur: () => base.handleBlur(),
      reset: () => base.reset(),
      $: base.$,
    } satisfies FormFieldInternal<O>

    if (extendFieldFn) Object.assign(translated, extendFieldFn(translated as any))

    return translated
  }
}
