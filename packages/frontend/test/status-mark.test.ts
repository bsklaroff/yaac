import { describe, expect, it } from 'vitest'
import { statusKind, statusText } from '#components/StatusMark'

describe('statusKind', () => {
  it('marks a waiting status amber only while the viewer has not seen it', () => {
    expect(statusKind('waiting', false, true)).toBe('unread')
    expect(statusKind('waiting', false, false)).toBe('done')
    expect(statusKind('waiting', false)).toBe('done')
    // An ask still wins.
    expect(statusKind('waiting', true, true)).toBe('need')
  })
})

describe('statusText', () => {
  it('names the amber mark apart from the white one', () => {
    expect(statusText('waiting', false, undefined, true)).toBe('Finished since you looked')
    expect(statusText('waiting', false)).toBe('Waiting')
  })
})
