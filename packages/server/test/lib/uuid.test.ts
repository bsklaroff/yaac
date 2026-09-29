import { describe, it, expect } from 'vitest'
import { isUuid } from '#lib/uuid'

describe('isUuid', () => {
  it('takes a uuid in either case and nothing else', () => {
    expect(isUuid('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true)
    expect(isUuid('0F8FAD5B-D9CB-469F-A165-70867728950E')).toBe(true)
    expect(isUuid('0f8fad5b-d9cb-469f-a165-70867728950')).toBe(false)
    expect(isUuid('x0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(false)
    expect(isUuid('nope')).toBe(false)
  })
})
