import { describe, it, expect } from 'vitest'
import { clipboardKeyAction, type ClipboardKey } from '#lib/clipboard'

const key = (over: Partial<ClipboardKey>): ClipboardKey => ({
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  key: 'c',
  ...over,
})

describe('clipboardKeyAction', () => {
  describe('mac (⌘ bindings)', () => {
    it('maps ⌘C to copy and ⌘V to paste', () => {
      expect(clipboardKeyAction(key({ metaKey: true, key: 'c' }), true)).toBe('copy')
      expect(clipboardKeyAction(key({ metaKey: true, key: 'v' }), true)).toBe('paste')
    })

    it('treats ⌘ with a held shift the same (⇧⌘V = paste)', () => {
      expect(clipboardKeyAction(key({ metaKey: true, shiftKey: true, key: 'v' }), true)).toBe('paste')
    })

    it('handles the uppercased key value shift produces', () => {
      expect(clipboardKeyAction(key({ metaKey: true, key: 'C' }), true)).toBe('copy')
    })

    it('leaves Ctrl+C alone so SIGINT still passes through', () => {
      expect(clipboardKeyAction(key({ ctrlKey: true, key: 'c' }), true)).toBeNull()
    })

    it('ignores Ctrl+Shift+C on mac (that is the non-mac binding)', () => {
      expect(clipboardKeyAction(key({ ctrlKey: true, shiftKey: true, key: 'c' }), true)).toBeNull()
    })
  })

  describe('non-mac (Ctrl+Shift bindings)', () => {
    it('maps Ctrl+Shift+C to copy and Ctrl+Shift+V to paste', () => {
      expect(clipboardKeyAction(key({ ctrlKey: true, shiftKey: true, key: 'c' }), false)).toBe('copy')
      expect(clipboardKeyAction(key({ ctrlKey: true, shiftKey: true, key: 'v' }), false)).toBe('paste')
    })

    it('leaves plain Ctrl+C (SIGINT) and Ctrl+V (quoted insert) alone', () => {
      expect(clipboardKeyAction(key({ ctrlKey: true, key: 'c' }), false)).toBeNull()
      expect(clipboardKeyAction(key({ ctrlKey: true, key: 'v' }), false)).toBeNull()
    })

    it('does not fire on the ⌘ combo when not on mac', () => {
      expect(clipboardKeyAction(key({ metaKey: true, key: 'c' }), false)).toBeNull()
    })

    it('does not fire when Super (meta) is also held', () => {
      expect(clipboardKeyAction(key({ ctrlKey: true, shiftKey: true, metaKey: true, key: 'c' }), false)).toBeNull()
    })
  })

  it('returns null for unrelated keys', () => {
    expect(clipboardKeyAction(key({ metaKey: true, key: 'a' }), true)).toBeNull()
    expect(clipboardKeyAction(key({ ctrlKey: true, shiftKey: true, key: 'x' }), false)).toBeNull()
    expect(clipboardKeyAction(key({ key: 'c' }), true)).toBeNull()
  })
})
