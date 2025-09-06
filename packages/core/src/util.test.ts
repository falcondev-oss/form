import { describe, expect, test } from 'vitest'
import { pathSegmentsToPathString } from './util'

describe(pathSegmentsToPathString.name, () => {
  test('single segment', () => {
    expect(pathSegmentsToPathString(['name'])).toBe('name')
  })
  test('nested object', () => {
    expect(pathSegmentsToPathString(['user', 'profile', 'name'])).toBe('user.profile.name')
  })
  test('array', () => {
    expect(pathSegmentsToPathString(['user', 'profile', 'friends', 0, 'name'])).toBe(
      'user.profile.friends[0].name',
    )
  })
})
