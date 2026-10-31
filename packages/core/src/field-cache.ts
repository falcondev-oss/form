import type { ArrayChange } from './data'
import type { FormField } from './field'
import { deleteProperty, setProperty } from 'dot-prop'
import { getFieldCachePath, getProperty } from './util'

// $field can be undefined if the field was never accessed via $use() directly
// e.g. only an array item was accessed -> 'array.$field' is never set
type FieldCacheItem = {
  $field: FormField<unknown> | undefined
  _array?: (FieldCacheItem | undefined)[]
}
export type FieldCache = Record<string, FieldCacheItem | undefined>

export function getCacheItem(cache: FieldCache, path: string): FieldCacheItem | undefined {
  return getProperty(cache, getFieldCachePath(path), undefined) as FieldCacheItem | undefined
}

export function getCachedField(cache: FieldCache, path: string) {
  return getCacheItem(cache, path)?.$field
}

export function setCachedField(cache: FieldCache, path: string, field: FormField<unknown>) {
  setProperty(cache, `${getFieldCachePath(path)}.$field`, field)
}

export function deleteCacheItem(cache: FieldCache, path: string) {
  deleteProperty(cache, getFieldCachePath(path))
}

/** Mirrors an array mutation on the cached item fields, so each field (and its key) moves with its item. */
export function applyArrayChange(cache: FieldCache, path: string, change: ArrayChange) {
  const items = getCacheItem(cache, path)?._array
  if (!items) return

  switch (change.type) {
    case 'splice':
      // the cache array may be shorter than the data (sparse $use)
      if (items.length < change.start) items.length = change.start
      items.splice(
        change.start,
        change.deleteCount,
        ...Array.from({ length: change.insertCount }, () => undefined),
      )
      break
    case 'permute': {
      const previous = [...items]
      items.length = change.order.length
      for (const [i, from] of change.order.entries()) items[i] = previous[from]
      break
    }
    case 'fill':
      items.fill(undefined, change.start, change.end)
      break
    case 'replace':
      deleteCacheItem(cache, path)
      break
  }
}
