import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { PathSegment } from './data'
import type { FormContext, FormField, LocatedIssue } from './field'
import type {
  BuildFormFieldAccessors,
  FormData,
  FormFieldAccessorOptions,
  FormHandle,
  FormHookDefinitions,
  FormHooks,
  FormOptions,
  FormSchema,
  FormSourceValues,
  ReadonlyDeep,
} from './types'
import {
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  runWithOwner,
  untrack,
} from '@solidjs/signals'
import { createHooks } from 'hookable'
import { klona } from 'klona/full'
import { hasAtLeast, isArray } from 'remeda'
import { createDiffer, createFormStore, toPlain } from './data'
import { assignDescriptors, createFormField } from './field'
import { toJsonSchema } from './json-schema'
import { locationId } from './location'
import { commit, observe, toValue } from './reactive'
import { extend } from './types'
import { debugLog } from './util'

export function useFormCore<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema> = FormSourceValues<Schema>,
>(formOpts: FormOptions<Schema, SourceValues>) {
  // inside a Solid owner the form is disposed with it; otherwise it lives as long as it is referenced
  return createRoot(() => createForm<Schema, SourceValues>(formOpts))
}

type Obj = Record<PropertyKey, unknown>

function issueSegments(issue: StandardSchemaV1.Issue): PathSegment[] | undefined {
  return issue.path?.map((segment) => {
    const key = typeof segment === 'object' ? segment.key : segment
    return typeof key === 'number' ? key : String(key)
  })
}

function createForm<
  const Schema extends FormSchema,
  SourceValues extends FormSourceValues<Schema>,
  const Data extends FormData<Schema> = FormData<Schema>,
>(formOpts: FormOptions<Schema, SourceValues>) {
  const owner = getOwner()!
  const hooks = createHooks<FormHookDefinitions<Schema>>()
  if (formOpts.hooks) hooks.addHooks(formOpts.hooks)

  const sourceValues = createMemo(() => toValue(formOpts.sourceValues) as Data | undefined)
  const [updateCount, setUpdateCount] = createSignal(0)
  const isDirty = createMemo(() => updateCount() !== 0)
  const isPending = createMemo(() => sourceValues() === undefined)
  const [isSubmitting, setIsSubmitting] = createSignal(false)
  const [isValidating, setIsValidating] = createSignal(false)
  const isLoading = createMemo(() => isPending() || isValidating() || isSubmitting())
  const isDisabled = createMemo(() => isLoading() || (toValue(formOpts.disabled) ?? false))
  const [issues, setIssues] = createSignal<LocatedIssue[] | undefined>(undefined)

  /** Fields by location id (item-bound) and by `field.key`. */
  const fieldsById = new Map<string, FormField<unknown>>()
  const fieldsByKey = new Map<string, FormField<unknown>>()
  const markEdited = () => setUpdateCount((c) => c + 1)

  const data = createFormStore(klona(untrack(sourceValues) ?? {}), {
    owner,
    itemKey: formOpts.itemKey,
  })
  // data and source share item keys, so an item finds its own source value after moving
  const [sourceStored, setSourceStored] = createSignal<unknown>(data.snapshotStored())
  const formData = data.root() as Data

  // the source may have properties the data does not
  const isChanged = createMemo(
    createDiffer(
      () => data.state,
      () => sourceValues() ?? {},
      true,
    ),
  )
  // issue paths follow their items: they show where the item is now
  const errors = createMemo(() => {
    const current = issues()?.map(({ issue, location }) => {
      const resolved = data.resolve(location)
      return resolved ? { ...issue, path: resolved.segments } : issue
    })
    return current && hasAtLeast(current, 1) ? current : undefined
  })

  function reset() {
    debugLog(() => ['useForm: reset()'])

    // items keep their keys (and fields) where they match the new source values
    const stored = data.prepare(klona(untrack(sourceValues) ?? {}))
    commit(() => {
      data.writeStored([], stored)
      setSourceStored(stored)
      setUpdateCount(0)
      setIssues(undefined)
    })
  }

  let queueReset = false
  observe(sourceValues, () => {
    if (isSubmitting()) {
      queueReset = true
      debugLog(() => ['useForm: Queued reset after successful submit'])
      return
    }

    if (isDirty()) {
      /* TODO: update all untouched fields & show info on outdated fields.
        form.sourceValues + sourceValues.timestamp

        field.isTouched.timestamp > sourceValues.timestamp: field was changed normally (option: undo)
        field.isTouched.timestamp < sourceValues.timestamp: field is outdated (option: update)
      */
      console.warn('useForm:', 'Skipped sourceValues update after form was edited')
      return
    }

    reset()
  })

  const standardSchema = formOpts.schema['~standard']
  const jsonSchema = toJsonSchema(formOpts.schema)

  /**
   * Validates all data and pins each issue to the item it was reported for.
   * Synchronous for synchronous schemas, so callers settle after a single `await`.
   */
  function runValidation() {
    const stored = data.snapshotStored()
    const locate = (result: StandardSchemaV1.Result<Schema>) => ({
      result,
      issues: result.issues?.flatMap((issue): LocatedIssue[] => {
        const segments = issueSegments(issue)
        if (!segments) return []
        const location = data.locateIn(stored, segments)
        return [{ issue, location, id: locationId(location) }]
      }),
    })

    const result = standardSchema.validate(toPlain(stored)) as
      StandardSchemaV1.Result<Schema> | Promise<StandardSchemaV1.Result<Schema>>
    return result instanceof Promise ? result.then(locate) : locate(result)
  }

  const context: FormContext<Schema> = {
    owner,
    hooks,
    opts: formOpts as FormContext<Schema>['opts'],
    jsonSchema,
    data,
    sourceStored,
    issues,
    setIssues,
    validate: () => {
      const validation = runValidation()
      return validation instanceof Promise ? validation.then((v) => v.issues) : validation.issues
    },
    isClaimed: (id) => fieldsById.has(id),
    rebind(field, previousId, nextId) {
      if (fieldsById.get(previousId) === field) fieldsById.delete(previousId)
      if (!fieldsById.has(nextId)) fieldsById.set(nextId, field)
    },
    accessor: (segments) => createAccessor(segments),
    markEdited,
    isDirty,
    isDisabled,
    isPending,
  }

  const discriminatedHandles = new WeakMap<FormField<unknown>, Map<string, object>>()

  /**
   * The handle `$use({ discriminator })` returns. Reading `handle[discriminator]`
   * is a tracked read of the live value, so after `if (handle.type === 'A')`
   * TypeScript narrows `handle.$field` and the check re-runs reactively.
   */
  function discriminatedHandle(field: FormField<unknown>, discriminator: string) {
    let byKey = discriminatedHandles.get(field)
    if (!byKey) discriminatedHandles.set(field, (byKey = new Map()))
    const cached = byKey.get(discriminator)
    if (cached) return cached

    const read = (key: PropertyKey) => {
      if (key === discriminator)
        return (field.api.value as Record<string, unknown> | null)?.[discriminator] ?? null
      if (key === '$field') return createAccessor(field.segments())
    }
    const keys = [discriminator, '$field']
    const handle = new Proxy(Object.create(null) as object, {
      get: (_target, key) => read(key),
      has: (_target, key) => keys.includes(key as string),
      ownKeys: () => keys,
      getOwnPropertyDescriptor: (_target, key) =>
        keys.includes(key as string)
          ? { value: read(key), enumerable: true, configurable: true, writable: false }
          : undefined,
    })
    byKey.set(discriminator, handle)
    return handle
  }

  /** `$use()`: the field of whatever is at `segments` now, bound to it from here on. */
  function useField(segments: PathSegment[], $opts?: FormFieldAccessorOptions<unknown>) {
    const location = data.locate(segments)
    const id = locationId(location)
    let field = fieldsById.get(id)
    if (!field) {
      debugLog(() => ['$use', id])

      field = runWithOwner(owner, () => {
        const created = createFormField<unknown, Schema>(location, context)
        assignDescriptors(created.api, formOpts[extend]?.setup?.(created.api))
        assignDescriptors(created.api, formOpts[extend]?.$use?.(created.api))
        return created
      })
      fieldsById.set(id, field)
      fieldsByKey.set(field.api.key, field)
    }

    if ($opts?.discriminator) return discriminatedHandle(field, $opts.discriminator)
    if ($opts?.translate) return field.translated($opts.translate)
    return field.api
  }

  function deleteItem(segments: PathSegment[], key: string) {
    if (!isArray(data.readAt(segments))) throw new Error("Can't delete item when field is null")
    if (!/@[^@]+$/.test(key)) throw new Error('Invalid key')

    const arrayLocation = untrack(() => data.locate(segments))
    const field = fieldsByKey.get(key)
    const itemLocation = field && untrack(field.location)
    const lastStep = itemLocation?.at(-1)
    if (
      !itemLocation ||
      !lastStep ||
      !('item' in lastStep) ||
      locationId(itemLocation.slice(0, -1)) !== locationId(arrayLocation)
    )
      throw new Error('Key does not reference an array item')

    const resolved = untrack(() => data.resolve(itemLocation))
    // already removed
    if (!resolved) return
    const index = resolved.segments.at(-1) as number
    update((root) => {
      const list = resolved.segments
        .slice(0, -1)
        .reduce<unknown>((node, segment) => (node as Obj)[segment], root)
      ;(list as unknown[]).splice(index, 1)
    })
  }

  /**
   * Applies `recipe` to a plain copy of the data in one edit. Items keep their
   * fields by object identity, so moving an item moves its field. Fields that
   * show errors are validated again; others stay quiet until blur or submit.
   */
  function update(recipe: (data: Obj) => void) {
    const changed = commit(() => {
      const edited = data.update(recipe)
      if (edited) markEdited()
      return edited
    })
    if (changed) void revalidateShown()
  }

  async function revalidateShown() {
    const shown = [...fieldsById.values()].filter((field) => untrack(() => field.api.errors))
    if (shown.length === 0) return
    const located = await context.validate()
    commit(() => {
      for (const field of shown) field.applyIssues(located)
    })
  }

  /** Accessors are addresses: every read and `$use()` resolves the position again. */
  function createAccessor(segments: PathSegment[]): BuildFormFieldAccessors<Data, false, true> {
    const read = () => data.readAt(segments)

    return new Proxy(Object.create(null) as BuildFormFieldAccessors<Data, false, true>, {
      ownKeys() {
        const node = read()
        if (isArray(node)) return [...node.keys()].map(String)
        return node !== null && typeof node === 'object' ? Object.keys(node) : []
      },
      getOwnPropertyDescriptor(_target, _key) {
        return { enumerable: true, configurable: true, writable: false }
      },
      has(_target, prop: string) {
        const node = read()
        if (isArray(node)) return /^\d+$/.test(prop) && Number(prop) < node.length
        return node !== null && typeof node === 'object' && Reflect.has(node, prop)
      },
      get(_target, prop: string | symbol) {
        if (prop === Symbol.iterator) {
          const node = read()
          if (node === null || node === undefined) return () => [].values()
          if (!isArray(node)) return

          // reading `length` here too subscribes whoever fetches the iterator (e.g. the Vue bridge)
          const { length } = node
          return () =>
            Array.from({ length: (read() as unknown[] | undefined)?.length ?? length }, (_, i) =>
              createAccessor([...segments, i]),
            ).values()
        }

        if (typeof prop === 'symbol') return

        if (prop === 'at') return (index: number) => createAccessor([...segments, index])
        if (prop === 'delete') return (key: string) => deleteItem(segments, key)
        if (prop === '$use')
          return ($opts?: FormFieldAccessorOptions<unknown>) => useField(segments, $opts)

        return createAccessor([...segments, prop])
      },
    })
  }

  async function validateForm() {
    await hooks.callHook('beforeValidate')
    const { result, issues: located } = await runValidation()
    await hooks.callHook('afterValidate', result)

    if (!located) {
      commit(() => setIssues(undefined))
      return result.issues ? undefined : result.value
    }

    commit(() => setIssues(located))

    for (const { issue, id } of located) {
      if (fieldsById.has(id)) continue
      console.warn('useForm: Detected validation issue in possibly unused field:', issue)
    }
  }

  async function submit() {
    await hooks.callHook('beforeSubmit', { data: formData })
    commit(() => setIsValidating(true))

    try {
      const values = await validateForm()
      commit(() => setIsValidating(false))
      if (!values) {
        const result = { success: false }
        await hooks.callHook('afterSubmit', result)
        return result
      }

      commit(() => setIsSubmitting(true))
      const submitResult = (await formOpts.submit({ values })) ?? { success: true }
      // don't reset because we don't want to overwrite the form data with the old sourceValues
      // (updates to sourceValues are handled by the observer)
      // -> only set the update count to 0 to mark the form as pristine
      commit(() => {
        setIsSubmitting(false)
        if (submitResult.success) setUpdateCount(0)
      })

      await hooks.callHook('afterSubmit', submitResult)

      if (queueReset) {
        queueReset = false
        if (submitResult.success) reset()
      }

      return submitResult
    } catch (err) {
      console.error(err)
      commit(() => {
        setIsValidating(false)
        setIsSubmitting(false)
      })

      const result = { success: false }
      await hooks.callHook('afterSubmit', result)

      return result
    }
  }

  const formApi = {
    hooks: hooks as FormHooks<FormHookDefinitions<Schema>>,
    fields: createAccessor([]),
    get isDirty() {
      return isDirty()
    },
    get isChanged() {
      return isChanged()
    },
    get isLoading() {
      return isLoading()
    },
    get isDisabled() {
      return isDisabled()
    },
    get data() {
      return (isPending() ? undefined : formData) as SourceValues extends undefined
        ? ReadonlyDeep<Data> | undefined
        : ReadonlyDeep<Data>
    },
    get errors() {
      return errors()
    },
    /** The only way to edit `form.data` directly: `form.setData((data) => { data.rows.push(row) })`. */
    setData: (recipe: (data: Data) => void) => update(recipe as (data: Obj) => void),
    reset,
    submit,
  }

  return formApi satisfies FormHandle
}
