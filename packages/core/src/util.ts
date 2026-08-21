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

export function escapePathSegment(segment: string) {
  return segment.replaceAll('.', String.raw`\.`)
}

export type ParsedSegment = { kind: 'prop'; key: string } | { kind: 'index'; index: number }

/** Parses a form path string (`a.b[2].c`, dots escapable via `\.`) into segments. */
export function parsePath(path: string): ParsedSegment[] {
  const segments: ParsedSegment[] = []
  let buf = ''

  const flushBuf = () => {
    if (buf !== '') segments.push({ kind: 'prop', key: buf })
    buf = ''
  }

  for (let i = 0; i < path.length; i++) {
    const char = path[i]
    if (char === '\\' && i + 1 < path.length) {
      buf += path[i + 1]
      i++
    } else if (char === '.') {
      flushBuf()
    } else if (char === '[') {
      flushBuf()
      const end = path.indexOf(']', i)
      segments.push({ kind: 'index', index: Number(path.slice(i + 1, end)) })
      i = end
    } else {
      buf += char
    }
  }
  flushBuf()

  return segments
}

/** Normalizes a Standard Schema issue path to plain keys (numeric strings become numbers). */
export function issuePathKeys(
  issuePath: readonly (PropertyKey | StandardSchemaV1.PathSegment)[] | undefined,
): PropertyKey[] {
  if (!issuePath) return []
  return issuePath.map((segment) => {
    const key = typeof segment === 'object' ? segment.key : segment
    return typeof key === 'string' && /^\d+$/.test(key) ? Number(key) : key
  })
}

export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

export function debugLog(getArgs: () => unknown[]) {
  // eslint-disable-next-line ts/no-unsafe-member-access
  const isDebug = !!(globalThis as any)?.__FORM_DEBUG__
  if (isDebug) console.debug(...getArgs())
}
