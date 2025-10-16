import type { StandardSchemaV1 } from '@standard-schema/spec'
import { getProperty as getProperty_ } from 'dot-prop'

export function pathSegmentsToPathString(
  issuePath: readonly (PropertyKey | StandardSchemaV1.PathSegment)[],
) {
  let path = ''

  for (const [i, element] of issuePath.entries()) {
    const p = element

    if (typeof p === 'number') {
      path += `[${p}]`
      continue
    }

    // only add dot if it's not the first element & not an array index
    if (i > 0) path += '.'

    if (typeof p === 'string' || typeof p === 'symbol') path += escapePathSegment(p.toString())
    else path += escapePathSegment(p.key.toString())
  }

  return path
}

export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function escapePathSegment(segment: string) {
  return segment.replaceAll('.', String.raw`\.`)
}

export const getProperty = ((
  ...args: Parameters<typeof getProperty_>
): ReturnType<typeof getProperty_> => {
  // empty path returns the object itself
  // https://github.com/sindresorhus/dot-prop/issues/123
  if (args[1].length === 0) return args[0]
  return getProperty_(...args)
}) as typeof getProperty_
