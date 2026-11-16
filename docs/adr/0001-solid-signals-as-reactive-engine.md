---
status: accepted
---

# Solid signals replace @vue/reactivity as the reactive engine

form-core was built on `@vue/reactivity` and observed writes to the form data with an `on-change` proxy. We replace both with `@solidjs/signals` (Solid 2). The engine must not belong to one UI framework: React consumers should not ship Vue's reactivity. Solid's model also fits a form library: state is read-only, writes pass through one channel, and a flush is explicit.

The form data is read-only. Every write goes through the form (a field, an array operation or a recipe), and the form flushes at once. So a read on the line after a write is current: the public contract stays synchronous.

## Considered Options

- **Keep `@vue/reactivity`.** Identity semantics do not need the change, because Vue also keeps one proxy for each object. Rejected for the reason above.
- **An asynchronous contract**, where values are current only after the next flush (issue #4). Rejected: it breaks every read after a write in consumer code and tests.
- **A peer dependency.** Rejected: consumers never import the engine, and its release candidates can break between versions. `@solidjs/signals` is a normal dependency of form-core, pinned to an exact version. The adapters use it only through form-core.

## Consequences

- Solid 2 is a release candidate at the time of this decision. An update of the engine is a deliberate change of the pinned version.
- The Vue adapter cannot rely on Vue tracking the form by itself. form-core reports each signal read to the adapter, and the adapter registers a Vue dependency for it. The form and its fields are plain objects: `isReactive(form)` is `false`, and `watch(form.data, …)` needs a getter.
