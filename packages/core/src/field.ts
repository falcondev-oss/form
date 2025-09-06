import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { ComputedRef, Ref } from '@vue/reactivity'
import type { Hookable } from 'hookable'
import type { ZodType } from 'zod'
import type {
  FormData,
  FormFieldContext,
  FormFieldInternal,
  FormFieldTranslator,
  FormHooks,
  FormOptions,
  FormSchema,
  NonPrimitiveReadonly,
} from './types'
import { computed, markRaw, reactive, readonly, ref, toRefs, watch } from '@vue/reactivity'
import { getProperty, setProperty } from 'dot-prop'
import { isDeepEqual } from 'remeda'
import { refEffect } from './reactive'
import { extend, setContext } from './types'
import { issuePathToDotNotation } from './util'
import { getValidatorByPath } from './validator'

export type Form<Schema extends FormSchema> = {
  hooks: Hookable<FormHooks<Schema>>
  disabled: Ref<boolean>
  updateCount: Ref<number>
  data: Partial<FormData<Schema>>
  opts: FormOptions<Schema>
  error: Ref<StandardSchemaV1.FailureResult | undefined>
  sourceValues: Ref<Partial<FormData<Schema>> | undefined>
  isLoading: Ref<boolean>
}

export class FormField<T, Schema extends FormSchema> {
  #form: Form<Schema>

  #now = Date.now()
  #validationError = ref<StandardSchemaV1.FailureResult>()
  #errors = refEffect(this.#transformValidationError.bind(this))
  #transformValidationError() {
    return this.#validationError.value && this.#validationError.value.issues.length > 0
      ? this.#validationError.value.issues.map((i) => i.message)
      : undefined
  }
  #updateCount = ref(0)
  #isEditing = ref(false)
  #value = ref<T | null>(null)
  protected getValue() {
    return getProperty(this.#form.data, this.#context.value.path, null) as T
  }

  #context: Ref<FormFieldContext<T>>
  #sourceValue: ComputedRef<T>
  api: FormFieldInternal<T>

  async #validate() {
    const formResult = await Promise.resolve(
      this.#form.opts.schema['~standard'].validate(this.#form.data),
    )
    if (!formResult.issues) {
      this.#validationError.value = undefined
      // fieldErrors.reset() // TODO: should be automatically
      return
    }

    this.#validationError.value = {
      issues: formResult.issues.filter((issue) => {
        if (!issue.path) return false
        const issuePath = issuePathToDotNotation(issue.path)
        return issuePath === this.#context.value.path
      }),
    } satisfies StandardSchemaV1.FailureResult
  }

  #handleChange(value: T) {
    if (this.#form.disabled.value) {
      console.warn(
        'useForm:',
        'handleChange() was blocked on a disabled field',
        `(${this.#context.value.path})`,
      )
      return
    }

    this.#isEditing.value = true

    // console.debug(
    //   `======== handleChange (${pathRef.value}): '${JSON.stringify(_value)}'`,
    // )
    void this.#form.hooks.callHook(
      'beforeFieldChange',
      this.api as FormFieldInternal<unknown>,
      value,
    )

    this.#value.value = value

    // const value = $opts?.translate?.set(_value) ?? _value
    setProperty(this.#form.data, this.#context.value.path, value)
    this.#isEditing.value = false

    this.#updateCount.value++
    this.#form.updateCount.value++

    void this.#form.hooks.callHook(
      'afterFieldChange',
      this.api as FormFieldInternal<unknown>,
      value,
    )

    if (this.#errors.value && this.#errors.value.length > 0) void this.#validate()
  }
  #handleBlur() {
    if (this.#form.disabled.value) {
      console.warn(
        'useForm:',
        'handleBlur() was blocked on a disabled field',
        `(${this.#context.value.path})`,
      )
      return
    }

    // console.debug(`======== handleBlur (${pathRef.value})`)
    if (this.#updateCount.value === 0) return

    void this.#validate()
  }
  #reset() {
    if (this.#form.disabled.value) {
      console.warn(
        'useForm:',
        'reset() was blocked on a disabled field',
        `(${this.#context.value.path})`,
      )
      return
    }
    // await hooks.callHook('beforeFieldReset')

    this.#updateCount.value = 0
    setProperty(this.#form.data, this.#context.value.path, this.#sourceValue.value)
    this.#validationError.value = undefined

    // await hooks.callHook('afterFieldReset')
  }

  #setContext(ctx: FormFieldContext<T>) {
    this.#context.value = ctx
    this.api.path = ctx.path
  }

  constructor(path: string, form: Form<Schema>) {
    this.#form = form

    this.#context = ref({ path })
    this.#sourceValue = computed(
      () => getProperty(form.sourceValues.value, this.#context.value.path, null) as T,
    )

    watch(
      () => this.getValue(),
      (value: T) => {
        // console.debug(`======== fieldValue (${pathRef.value})`)
        if (this.#isEditing.value) return

        this.#value.value = value
      },
      { immediate: true },
    )

    watch(form.updateCount, () => {
      if (form.updateCount.value === 0) this.#updateCount.value = 0
    })
    watch(form.error, () => {
      this.#validationError.value = form.error.value
        ? ({
            issues: form.error.value.issues.filter((issue) => {
              if (!issue.path) return false
              const issuePath = issuePathToDotNotation(issue.path)
              return issuePath === this.#context.value.path
            }),
          } satisfies StandardSchemaV1.FailureResult)
        : undefined
    })
    watch(form.isLoading, () => {
      if (form.isLoading.value) this.#errors.reset()
    })

    const validator = getValidatorByPath(
      form.opts.schema as unknown as ZodType,
      path.replaceAll(/\[(\d+)\]/g, '.$1').split('.'),
    )

    const api = reactive({
      disabled: form.disabled,
      errors: this.#errors,
      handleChange: this.#handleChange.bind(this),
      handleBlur: this.#handleBlur.bind(this),
      reset: this.#reset.bind(this),
      isChanged: computed(() => !isDeepEqual<unknown>(this.#value.value, this.#sourceValue.value)),
      isDirty: computed(() => this.#updateCount.value !== 0),
      value: readonly(this.#value) as Ref<NonPrimitiveReadonly<T>>,
      path,
      key: `${path}@${this.#now}`,
      validator: validator ? markRaw(validator) : undefined,
      [setContext]: this.#setContext.bind(this),
    })
    this.api = api satisfies FormFieldInternal<T>
  }

  translatedApi<TT extends T, O>(translator: FormFieldTranslator<TT, O>) {
    const extendFieldFn = this.#form.opts[extend]?.$use

    const translatedField = reactive({
      ...toRefs(this.api),
      value: computed(() => translator.get(this.api.value as TT) as NonPrimitiveReadonly<O>),
      handleChange: (value: O) => {
        const v = translator.set(value)
        return this.api.handleChange(v)
      },
      [setContext]: this.api[setContext],
    })

    if (extendFieldFn) {
      Object.assign(translatedField, extendFieldFn(translatedField))
    }

    return translatedField
  }
}
