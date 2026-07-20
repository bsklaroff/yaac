import { describe, it, expect } from 'vitest'
import {
  CYCLE_IDS,
  DEFAULT_BINDINGS,
  SHORTCUTS,
  chordFromEvent,
  chordMatches,
  chordsEqual,
  cycleDeltaFor,
  formatChord,
  formatCode,
  isChord,
  isModifierCode,
  isShortcutId,
  matchShortcut,
  mergeBindings,
  resolveCycleTarget,
  validateChord,
  type Chord,
  type ShortcutKey,
} from '#lib/shortcuts'

/** An Alt-held keydown for `code`, override any field. */
const key = (code: string, over: Partial<ShortcutKey> = {}): ShortcutKey => ({
  altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, code, ...over,
})

const chord = (code: string, over: Partial<Chord> = {}): Chord => ({
  code, alt: true, ctrl: false, meta: false, shift: false, ...over,
})

describe('SHORTCUTS registry', () => {
  it('covers every id in DEFAULT_BINDINGS with a unique default chord', () => {
    expect(Object.keys(DEFAULT_BINDINGS).sort()).toEqual(SHORTCUTS.map((s) => s.id).sort())
    const seen = new Set<string>()
    for (const def of SHORTCUTS) {
      const k = JSON.stringify(def.defaultChord)
      expect(seen.has(k)).toBe(false) // no two defaults collide
      seen.add(k)
    }
  })

  it('marks the four directional cyclers, and only those, as CYCLE_IDS', () => {
    expect([...CYCLE_IDS].sort()).toEqual(
      ['next-session', 'next-terminal', 'prev-session', 'prev-terminal'],
    )
  })
})

describe('isShortcutId', () => {
  it('accepts known ids and rejects others', () => {
    expect(isShortcutId('new-session')).toBe(true)
    expect(isShortcutId('next-terminal')).toBe(true)
    expect(isShortcutId('nope')).toBe(false)
    expect(isShortcutId('')).toBe(false)
  })
})

describe('chordFromEvent', () => {
  it('normalizes the five keyboard fields into a Chord', () => {
    expect(chordFromEvent(key('KeyN'))).toEqual(chord('KeyN'))
    expect(chordFromEvent(key('KeyK', { ctrlKey: true, shiftKey: true, altKey: false })))
      .toEqual({ code: 'KeyK', alt: false, ctrl: true, meta: false, shift: true })
  })
})

describe('chordsEqual', () => {
  it('is true only for structurally identical chords', () => {
    expect(chordsEqual(chord('KeyN'), chord('KeyN'))).toBe(true)
    expect(chordsEqual(chord('KeyN'), chord('KeyM'))).toBe(false)
    expect(chordsEqual(chord('KeyN'), chord('KeyN', { ctrl: true }))).toBe(false)
  })
})

describe('chordMatches', () => {
  it('matches exact code + all four modifier states', () => {
    expect(chordMatches(chord('KeyN'), key('KeyN'))).toBe(true)
    expect(chordMatches(chord('KeyN'), key('KeyM'))).toBe(false)
  })

  it('requires every modifier flag to line up — AltGr (Ctrl+Alt) never matches an Alt-only chord', () => {
    expect(chordMatches(chord('KeyN'), key('KeyN', { altKey: false }))).toBe(false)
    expect(chordMatches(chord('KeyN'), key('KeyN', { shiftKey: true }))).toBe(false)
    expect(chordMatches(chord('KeyN'), key('KeyN', { metaKey: true }))).toBe(false)
    expect(chordMatches(chord('KeyN'), key('KeyN', { ctrlKey: true }))).toBe(false)
  })
})

describe('matchShortcut', () => {
  it('maps each default chord to its command', () => {
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyN'))).toBe('new-session')
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyT'))).toBe('new-shell')
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyD'))).toBe('delete-session')
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyW'))).toBe('kill-terminal')
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyB'))).toBe('jump-attention')
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyF'))).toBe('find-changes')
    expect(matchShortcut(DEFAULT_BINDINGS, key('ArrowUp'))).toBe('prev-session')
    expect(matchShortcut(DEFAULT_BINDINGS, key('ArrowDown'))).toBe('next-session')
    expect(matchShortcut(DEFAULT_BINDINGS, key('ArrowLeft'))).toBe('prev-terminal')
    expect(matchShortcut(DEFAULT_BINDINGS, key('ArrowRight'))).toBe('next-terminal')
  })

  it('returns null for an unbound chord', () => {
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyM'))).toBeNull()
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyN', { ctrlKey: true }))).toBeNull()
  })

  it('honors a rebind', () => {
    const bindings = { ...DEFAULT_BINDINGS, 'new-session': chord('KeyG') }
    expect(matchShortcut(bindings, key('KeyG'))).toBe('new-session')
    expect(matchShortcut(bindings, key('KeyN'))).toBeNull()
  })
})

describe('cycleDeltaFor', () => {
  it('maps prev/next cyclers to -1/1 and non-cyclers to null', () => {
    expect(cycleDeltaFor('prev-session')).toBe(-1)
    expect(cycleDeltaFor('prev-terminal')).toBe(-1)
    expect(cycleDeltaFor('next-session')).toBe(1)
    expect(cycleDeltaFor('next-terminal')).toBe(1)
    expect(cycleDeltaFor('new-session')).toBeNull()
    expect(cycleDeltaFor('jump-attention')).toBeNull()
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

describe('isModifierCode', () => {
  it('is true for bare modifier keys only', () => {
    expect(isModifierCode('AltLeft')).toBe(true)
    expect(isModifierCode('ControlRight')).toBe(true)
    expect(isModifierCode('MetaLeft')).toBe(true)
    expect(isModifierCode('ShiftRight')).toBe(true)
    expect(isModifierCode('KeyN')).toBe(false)
    expect(isModifierCode('ArrowLeft')).toBe(false)
  })
})

describe('validateChord', () => {
  it('rejects a lone modifier keypress', () => {
    const r = validateChord(chord('AltLeft'), DEFAULT_BINDINGS, 'new-session')
    expect(r.ok).toBe(false)
  })

  it('requires a real modifier — Alt, Ctrl, or Meta', () => {
    expect(validateChord(chord('KeyG', { alt: false }), DEFAULT_BINDINGS, 'new-session').ok).toBe(false)
    // Shift alone is not enough.
    expect(validateChord(chord('KeyG', { alt: false, shift: true }), DEFAULT_BINDINGS, 'new-session').ok).toBe(false)
    expect(validateChord(chord('KeyG'), DEFAULT_BINDINGS, 'new-session').ok).toBe(true)
    expect(validateChord(chord('KeyG', { alt: false, ctrl: true }), DEFAULT_BINDINGS, 'new-session').ok).toBe(true)
  })

  it('rejects a chord already bound to a different command, with its label', () => {
    const r = validateChord(chord('KeyD'), DEFAULT_BINDINGS, 'new-session')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('Delete session')
  })

  it('allows rebinding a command to its own current chord', () => {
    expect(validateChord(chord('KeyN'), DEFAULT_BINDINGS, 'new-session').ok).toBe(true)
  })
})

describe('isChord', () => {
  it('accepts a well-formed chord and rejects malformed values', () => {
    expect(isChord(chord('KeyN'))).toBe(true)
    expect(isChord(null)).toBe(false)
    expect(isChord({ code: 'KeyN', alt: true })).toBe(false) // missing flags
    expect(isChord({ code: 1, alt: true, ctrl: true, meta: true, shift: true })).toBe(false)
  })
})

describe('mergeBindings', () => {
  it('overlays known ids and ignores unknown ids and malformed chords', () => {
    const merged = mergeBindings({
      'new-session': chord('KeyG'),
      'bogus-id': chord('KeyZ'),
      'kill-terminal': { code: 'KeyW' }, // malformed — dropped
    })
    expect(merged['new-session']).toEqual(chord('KeyG'))
    expect(merged['kill-terminal']).toEqual(DEFAULT_BINDINGS['kill-terminal'])
    expect((merged as Record<string, unknown>)['bogus-id']).toBeUndefined()
  })

  it('returns a copy of the defaults for empty overrides', () => {
    expect(mergeBindings({})).toEqual(DEFAULT_BINDINGS)
  })
})

describe('formatCode', () => {
  it('humanizes letters, digits, arrows, and named keys', () => {
    expect(formatCode('KeyN')).toBe('N')
    expect(formatCode('Digit1')).toBe('1')
    expect(formatCode('ArrowLeft')).toBe('←')
    expect(formatCode('ArrowRight')).toBe('→')
    expect(formatCode('Enter')).toBe('Enter')
    expect(formatCode('F5')).toBe('F5') // unknown → raw code
  })
})

describe('formatChord', () => {
  it('renders modifier+key with +-separators off mac', () => {
    expect(formatChord(chord('KeyN'))).toBe('Alt+N')
    expect(formatChord(chord('KeyK', { alt: false, ctrl: true, shift: true }))).toBe('Ctrl+Shift+K')
    expect(formatChord(chord('ArrowRight'))).toBe('Alt+→')
  })

  it('uses the platform glyphs on mac', () => {
    expect(formatChord(chord('KeyN'), true)).toBe('⌥N')
    expect(formatChord(chord('KeyK', { alt: false, ctrl: true, meta: true }), true)).toBe('⌃⌘K')
  })
})
