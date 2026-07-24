# @falcondev-oss/form

<a href="https://npmjs.org/package/@falcondev-oss/form-core" title="View this project on NPM"><img src="https://img.shields.io/npm/v/@falcondev-oss/form-core.svg?label=form-core" alt="NPM version" /></a>
<a href="https://npmjs.org/package/@falcondev-oss/form-vue" title="View this project on NPM"><img src="https://img.shields.io/npm/v/@falcondev-oss/form-vue.svg?label=form-vue" alt="NPM version" /></a>
<a href="https://npmjs.org/package/@falcondev-oss/form-react" title="View this project on NPM"><img src="https://img.shields.io/npm/v/@falcondev-oss/form-react.svg?label=form-react" alt="NPM version" /></a>

Type-safe, framework agnostic form state library.

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

## Writes and batching

Writes to `form.data`, field changes, and `form.setData(recipe)` are batched and become
observable on the next microtask. Framework bindings flush before rendering. Imperative
code and tests can force pending values with the internal `form['~'].flush()` escape hatch.

Object-array fields keep their `key`, dirty state, and errors when rows move. Primitive-array
fields remain positional because primitive values have no reference identity.

## Example
