import type { StandardSchemaV1 } from '@standard-schema/spec'
import { getProperty as getProperty_ } from 'dot-prop'

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

export function getFieldCachePath(path: string) {
  return `${path.replaceAll('[', '._array[')}`
}

export const getProperty = ((
  ...args: Parameters<typeof getProperty_>
): ReturnType<typeof getProperty_> => {
  // empty path returns the object itself
  // https://github.com/sindresorhus/dot-prop/issues/123
  if (args[1].length === 0) return args[0]
  return getProperty_(...args)
}) as typeof getProperty_

export function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

export function debugLog(...args: unknown[]) {
  // eslint-disable-next-line ts/no-unsafe-member-access
  const isDebug = !!(globalThis as any)?.__FORM_DEBUG__
  if (isDebug) console.debug(...args)
}
