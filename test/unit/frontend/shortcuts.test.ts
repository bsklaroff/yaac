import { describe, it, expect } from 'vitest'
import { matchAttentionShortcut, matchCloseShortcut, matchCreateShortcut, matchSessionShortcut, matchTabShortcut, resolveCycleTarget, type ShortcutKey } from '@/frontend/lib/shortcuts'

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

describe('matchCloseShortcut', () => {
  it('maps Alt+W to kill-terminal and Alt+D to delete-session', () => {
    expect(matchCloseShortcut(key('KeyW'))).toBe('kill-terminal')
    expect(matchCloseShortcut(key('KeyD'))).toBe('delete-session')
  })

  it('requires Alt alone — extra or missing modifiers never match', () => {
    expect(matchCloseShortcut(key('KeyW', { altKey: false }))).toBeNull()
    expect(matchCloseShortcut(key('KeyW', { metaKey: true }))).toBeNull()
    expect(matchCloseShortcut(key('KeyD', { shiftKey: true }))).toBeNull()
    // AltGr layouts report Ctrl+Alt — their characters must pass through.
    expect(matchCloseShortcut(key('KeyD', { ctrlKey: true }))).toBeNull()
  })

  it('ignores other keys — the creates belong to matchCreateShortcut', () => {
    expect(matchCloseShortcut(key('KeyN'))).toBeNull()
    expect(matchCloseShortcut(key('KeyT'))).toBeNull()
    expect(matchCloseShortcut(key('Enter'))).toBeNull()
  })
})

describe('matchAttentionShortcut', () => {
  it('matches Alt+B', () => {
    expect(matchAttentionShortcut(key('KeyB'))).toBe(true)
  })

  it('requires Alt alone — extra or missing modifiers never match', () => {
    expect(matchAttentionShortcut(key('KeyB', { altKey: false }))).toBe(false)
    expect(matchAttentionShortcut(key('KeyB', { shiftKey: true }))).toBe(false)
    expect(matchAttentionShortcut(key('KeyB', { metaKey: true }))).toBe(false)
    // AltGr layouts report Ctrl+Alt — their characters must pass through.
    expect(matchAttentionShortcut(key('KeyB', { ctrlKey: true }))).toBe(false)
  })

  it('ignores other keys', () => {
    expect(matchAttentionShortcut(key('KeyN'))).toBe(false)
    expect(matchAttentionShortcut(key('KeyV'))).toBe(false)
    expect(matchAttentionShortcut(key('ArrowDown'))).toBe(false)
  })
})
