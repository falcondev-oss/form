# @falcondev-oss/form

<a href="https://npmjs.org/package/@falcondev-oss/form-core" title="View this project on NPM"><img src="https://img.shields.io/npm/v/@falcondev-oss/form-core.svg?label=form-core" alt="NPM version" /></a>
<a href="https://npmjs.org/package/@falcondev-oss/form-vue" title="View this project on NPM"><img src="https://img.shields.io/npm/v/@falcondev-oss/form-vue.svg?label=form-vue" alt="NPM version" /></a>
<a href="https://npmjs.org/package/@falcondev-oss/form-react" title="View this project on NPM"><img src="https://img.shields.io/npm/v/@falcondev-oss/form-react.svg?label=form-react" alt="NPM version" /></a>

Type-safe, framework agnostic form state library based on @solidjs/signals.

## Installation

```bash
npm add @falcondev-oss/form-core
```

```bash
npm add @falcondev-oss/form-react
```

```bash
npm add @falcondev-oss/form-vue
```

## Array fields and writes

Object and array fields keep their identity when their values move. Use `field.key`
as your Vue or React list key. Primitive array fields keep their state at the same
index. `array.delete(field.key)` finds the current element by identity.

```ts
const first = form.fields.items.at(0).$use()
form.setData((draft) => {
  draft.items?.reverse()
  draft.name = 'Jane'
})
```

Direct writes also work, including assignment, deletion, and native array methods.
`form.data` contains only schema data. Files, blobs, and class instances are opaque
leaves, updated by replacement.

Writes batch on a microtask. Read derived values after the batch flushes. Vue and
React bindings subscribe to flushed state. For imperative tests, use the internal
`form['~'].flush()` hook before asserting values. Validation remains asynchronous;
await `form.submit()` or the validation result you are observing.

`setData(recipe)` applies its synchronous edits in one batch with one whole-schema
validation. Writes and recipes return no settlement promise.

| Operation                                                           | Field identity                                      |
| ------------------------------------------------------------------- | --------------------------------------------------- |
| Move, sort, splice, or replace object rows with the same references | Follows the object                                  |
| Reorder primitive values                                            | Stays at the index                                  |
| `reset()`                                                           | Reconciles positionally, preserving existing fields |
| Pristine source refresh                                             | Reconciles positionally by default                  |
| Source refresh with `key: 'id'`                                     | Preserves matching object rows by id                |

A key resolver is also supported, for example
`key: (item) => 'id' in item ? item.id : undefined`. Dirty forms skip source
refreshes with a warning. A refresh during submission applies only after a
successful submit.

## Migration from the Vue reactivity engine

- Core uses the pinned `@solidjs/signals` prerelease. Core getters and disabled
  options accept values or signal getters. Vue's adapter continues to accept Vue
  refs and getters.
- Vue `field.model` remains writable with `v-model`. React `field.model` remains
  `{ value, onUpdate }`; child components use `useField` or `FormFieldMemo`.
- Field keys are opaque strings. Do not parse indices from them.
- The `/reactive` entry exports signals primitives instead of `refEffect`,
  `toReactive`, and `reactiveComputed`.
- Standalone core owners can release effects with `form['~'].dispose()`. Framework
  adapters handle lifecycle cleanup.

The pinned release does not expose reverse paths for store nodes. Core derives
field paths from the live tree using stable store proxy identity. It tracks data
by reading the tree because `rc.6`'s `deep()` misses nested edits after a sibling
edit. Neither operation mirrors array mutations.

## Development

```sh
pnpm install
pnpm test
pnpm type-check
pnpm lint
pnpm build
```
