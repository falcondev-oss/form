import type { StandardSchemaV1 } from '@standard-schema/spec'

export function pathSegmentsToPathString(
  issuePath: readonly (PropertyKey | StandardSchemaV1.PathSegment)[],
) {
  let path = ''

  for (const [i, segment] of issuePath.entries()) {
    const prop = typeof segment === 'object' ? segment.key : segment

    if (typeof prop === 'number' || (typeof prop === 'string' && /^\d+$/.test(prop))) {
      path += `[${prop}]`
      continue
    }

    // only add dot if it's not the first element & not an array index
    if (i > 0) path += '.'

    path += escapePathSegment(prop.toString())
  }

  return path
}

export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function escapePathSegment(segment: string) {
  return segment.replaceAll('.', String.raw`\.`)
}

export function debugLog(getArgs: () => unknown[]) {
  if (Reflect.get(globalThis, '__FORM_DEBUG__')) console.debug(...getArgs())
}
