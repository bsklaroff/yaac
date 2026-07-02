import { describe, it, expect } from 'vitest'
import { matchTabShortcut, resolveTabShortcut, type ShortcutKey } from '@/frontend/lib/shortcuts'

const key = (code: string, over: Partial<ShortcutKey> = {}): ShortcutKey => ({
  altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, code, ...over,
})

describe('matchTabShortcut', () => {
  it('maps Alt+← / Alt+→ to previous / next', () => {
    expect(matchTabShortcut(key('ArrowLeft'))).toBe(-1)
    expect(matchTabShortcut(key('ArrowRight'))).toBe(1)
  })

  it('requires Alt alone — extra or missing modifiers never match', () => {
    expect(matchTabShortcut(key('ArrowLeft', { altKey: false }))).toBeNull()
    expect(matchTabShortcut(key('ArrowLeft', { shiftKey: true }))).toBeNull()
    expect(matchTabShortcut(key('ArrowRight', { metaKey: true }))).toBeNull()
    // AltGr layouts report Ctrl+Alt — their characters must pass through.
    expect(matchTabShortcut(key('ArrowRight', { ctrlKey: true }))).toBeNull()
  })

  it('ignores other keys', () => {
    expect(matchTabShortcut(key('ArrowUp'))).toBeNull()
    expect(matchTabShortcut(key('KeyJ'))).toBeNull()
    expect(matchTabShortcut(key('Digit1'))).toBeNull()
  })
})

describe('resolveTabShortcut', () => {
  const targets = ['agent', 'window:@1', 'shell:shell']

  it('cycles from the active target, wrapping at both ends', () => {
    expect(resolveTabShortcut(targets, 'agent', 1)).toBe('window:@1')
    expect(resolveTabShortcut(targets, 'shell:shell', 1)).toBe('agent')
    expect(resolveTabShortcut(targets, 'agent', -1)).toBe('shell:shell')
    expect(resolveTabShortcut(targets, 'window:@1', -1)).toBe('agent')
  })

  it('enters the list from the headed-toward end without a valid active target', () => {
    expect(resolveTabShortcut(targets, undefined, 1)).toBe('agent')
    expect(resolveTabShortcut(targets, 'window:@9', -1)).toBe('shell:shell')
  })

  it('returns null with nothing to switch to', () => {
    expect(resolveTabShortcut([], 'agent', 1)).toBeNull()
    expect(resolveTabShortcut([], undefined, -1)).toBeNull()
  })
})
