import { createStore, createRoot, createEffect, flush } from '@solidjs/signals'
import { expect, test } from 'vitest'
import { writable } from './reactive'

test('writable facade batches native array mutations and preserves object identity', () => {
  const [store] = createStore({
    rows: [{ name: 'a' }, { name: 'b' }],
    optional: true as boolean | undefined,
  })
  const data = writable(store)
  const first = data.rows[0]
  data.rows.reverse()
  data.rows.push({ name: 'c' })
  delete data.optional
  flush()
  expect(data.rows[1]).toBe(first)
  expect(data.rows.map((row) => row.name)).toEqual(['b', 'a', 'c'])
  expect(JSON.parse(JSON.stringify(data))).toEqual({
    rows: [{ name: 'b' }, { name: 'a' }, { name: 'c' }],
  })
})

test('array reads remain tracked by the engine', () => {
  const [store] = createStore({ rows: [{ name: 'a' }] })
  const data = writable(store)
  const values: string[][] = []
  createRoot(() =>
    createEffect(
      () => data.rows.map((row) => row.name),
      (value) => {
        values.push(value)
      },
    ),
  )
  flush()
  data.rows[0]!.name = 'b'
  flush()
  expect(values).toEqual([['a'], ['b']])
})
