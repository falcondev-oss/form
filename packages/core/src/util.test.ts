import { describe, expect, test } from 'vitest'
import { issuePathToDotNotation } from './util'

describe(issuePathToDotNotation.name, () => {
  test('single segment', () => {
    expect(issuePathToDotNotation(['name'])).toBe('name')
  })
  test('nested object', () => {
    expect(issuePathToDotNotation(['user', 'profile', 'name'])).toBe('user.profile.name')
  })
  test('array', () => {
    expect(issuePathToDotNotation(['user', 'profile', 'friends', 0, 'name'])).toBe(
      'user.profile.friends[0].name',
    )
  })
})
