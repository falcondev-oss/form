/**
 * Where a field or data proxy points. An array item is named by its stored key,
 * so the location follows the item when the array is reordered. An `index`
 * step is a position with no item yet; it binds to the first item there.
 */
export type Step = { prop: string } | { item: string } | { index: number }
export type Location = readonly Step[]

const SEPARATOR = '\u0000'

export function locationId(location: Location) {
  let id = ''
  for (const step of location) {
    id +=
      SEPARATOR +
      ('prop' in step ? `p${step.prop}` : 'item' in step ? `i${step.item}` : `x${step.index}`)
  }
  return id
}

/** Whether `id` is `parentId` or a location nested in it. */
export function isWithin(id: string, parentId: string) {
  return id === parentId || id.startsWith(parentId + SEPARATOR)
}

export function hasPendingStep(location: Location) {
  return location.some((step) => 'index' in step)
}
