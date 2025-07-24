import type { StandardSchemaV1 } from '@standard-schema/spec'

export function issuePathToDotNotation(
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

    if (typeof p === 'string' || typeof p === 'symbol') path += p.toString()
    else path += p.key.toString()
  }

  return path
}
