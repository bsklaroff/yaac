import { describe, it, expect } from 'vitest'
import { matchCreateShortcut, matchSessionShortcut, matchTabShortcut, resolveCycleTarget, type ShortcutKey } from '@/frontend/lib/shortcuts'

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

describe('matchSessionShortcut', () => {
  it('maps Alt+↑ / Alt+↓ to previous / next', () => {
    expect(matchSessionShortcut(key('ArrowUp'))).toBe(-1)
    expect(matchSessionShortcut(key('ArrowDown'))).toBe(1)
  })

  it('requires Alt alone — extra or missing modifiers never match', () => {
    expect(matchSessionShortcut(key('ArrowUp', { altKey: false }))).toBeNull()
    expect(matchSessionShortcut(key('ArrowUp', { shiftKey: true }))).toBeNull()
    expect(matchSessionShortcut(key('ArrowDown', { metaKey: true }))).toBeNull()
    // AltGr layouts report Ctrl+Alt — their characters must pass through.
    expect(matchSessionShortcut(key('ArrowDown', { ctrlKey: true }))).toBeNull()
  })

  it('ignores other keys — the horizontal arrows belong to the tab cycler', () => {
    expect(matchSessionShortcut(key('ArrowLeft'))).toBeNull()
    expect(matchSessionShortcut(key('ArrowRight'))).toBeNull()
    expect(matchSessionShortcut(key('KeyJ'))).toBeNull()
  })
})

describe('resolveCycleTarget', () => {
  const targets = ['agent', 'window:@1', 'shell:shell']

  it('cycles from the active target, wrapping at both ends', () => {
    expect(resolveCycleTarget(targets, 'agent', 1)).toBe('window:@1')
    expect(resolveCycleTarget(targets, 'shell:shell', 1)).toBe('agent')
    expect(resolveCycleTarget(targets, 'agent', -1)).toBe('shell:shell')
    expect(resolveCycleTarget(targets, 'window:@1', -1)).toBe('agent')
  })

  it('enters the list from the headed-toward end without a valid active target', () => {
    expect(resolveCycleTarget(targets, undefined, 1)).toBe('agent')
    expect(resolveCycleTarget(targets, 'window:@9', -1)).toBe('shell:shell')
  })

  it('returns null with nothing to switch to', () => {
    expect(resolveCycleTarget([], 'agent', 1)).toBeNull()
    expect(resolveCycleTarget([], undefined, -1)).toBeNull()
  })
})

describe('matchCreateShortcut', () => {
  it('maps Alt+N to new-session and Alt+T to new-shell', () => {
    expect(matchCreateShortcut(key('KeyN'))).toBe('new-session')
    expect(matchCreateShortcut(key('KeyT'))).toBe('new-shell')
  })

  it('requires Alt alone — extra or missing modifiers never match', () => {
    expect(matchCreateShortcut(key('KeyN', { altKey: false }))).toBeNull()
    expect(matchCreateShortcut(key('KeyN', { metaKey: true }))).toBeNull()
    expect(matchCreateShortcut(key('KeyT', { shiftKey: true }))).toBeNull()
    // AltGr layouts report Ctrl+Alt — their characters must pass through.
    expect(matchCreateShortcut(key('KeyT', { ctrlKey: true }))).toBeNull()
  })

  it('ignores other keys', () => {
    expect(matchCreateShortcut(key('KeyM'))).toBeNull()
    expect(matchCreateShortcut(key('Enter'))).toBeNull()
  })
})
