import { createReaction, createRoot, flush, untrack } from '@solidjs/signals'
import { isArray, isPlainObject } from 'remeda'

let commitDepth = 0
let callbackDepth = 0

/**
 * Runs `fn` and applies its writes synchronously, so reads right after a form
 * mutation see the new state (Solid 2.0 otherwise holds writes until the next
 * flush).
 */
export function commit<T>(fn: () => T): T {
  // a flush is already running: Solid applies these writes in its continuation
  if (commitDepth > 0 || callbackDepth > 0) return fn()

  commitDepth++
  try {
    return flush(fn)
  } finally {
    commitDepth--
  }
}

/**
 * Calls `onChange` (untracked) every time a reactive value read by `source`
 * changes. Tracking starts synchronously, so a change in the very next flush is
 * not missed. Returns a function that stops observing.
 */
export function observe(source: () => unknown, onChange: () => void): () => void {
  return createRoot((dispose) => {
    const track = createReaction(() => {
      track(source)
      callbackDepth++
      try {
        untrack(onChange)
      } finally {
        callbackDepth--
      }
    })
    track(source)
    return dispose
  })
}

/** Reads every nested property of plain objects and arrays, so a tracking scope subscribes to all of them. */
export function trackDeep<T>(value: T, seen = new Set<unknown>()): T {
  if (seen.has(value)) return value
  if (isArray(value)) {
    seen.add(value)
    for (const item of value) trackDeep(item, seen)
  } else if (isPlainObject(value)) {
    seen.add(value)
    for (const item of Object.values(value)) trackDeep(item, seen)
  }
  return value
}

export function toValue<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value
}
