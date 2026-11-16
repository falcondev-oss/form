---
status: accepted
---

# One node tree holds values and field state; form data is a read-only view

Fields were bound to an array index, and a separate field cache was kept in step with the data by replaying each array method. A reordered array left dirty state, errors and keys at the old positions. We now keep one tree: every value, primitives included, has a node that holds its item key, its value and its field state. An array node holds its item nodes in order, and an array operation reorders that list. A node never changes its parent. `form.data` and `field.value` are live read-only views over the nodes.

With one structure there is nothing to keep in step, and a primitive gets a key because its node has one.

## Considered Options

- **Plain data in a Solid store, with item keys and field state beside it.** Rejected: a store holds no key for a primitive, so the second structure returns.
- **The node tree as a Solid store of node records.** Rejected: each read passes two proxies, a keyed `reconcile` gives a new proxy to a record that nothing tracks at that moment, and the store module was still changing during the release candidates. The nodes use plain signals and memos.
- **A writable `form.data`.** Rejected: it needs a proxy that forwards writes, with separate handling for each array method. That is the code this decision removes.

## Consequences

- When a write replaces a whole array (`handleChange(array)`, a recipe result, `reset()`, new source values), the form must decide which new value is which item. It takes, in this order: the same object, an equal primitive, the same key property (when the form sets one), the same index. Any other value is a new item. An array operation needs no such rule and is exact.
- `isChanged` does not follow an item. It compares a value with the source value at the same path, as before. Dirty state and errors follow the item.
