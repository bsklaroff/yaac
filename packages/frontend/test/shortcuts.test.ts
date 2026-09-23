import { describe, it, expect } from 'vitest'
import {
  CYCLE_IDS,
  DEFAULT_BINDINGS,
  findChord,
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
  saveChord,
  textSizeStep,
  UNBOUND,
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

  it('opens the file tree on Alt+E, and has no entry for saving', () => {
    expect(DEFAULT_BINDINGS['open-files']).toEqual(chord('KeyE'))
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyE'))).toBe('open-files')
    expect(SHORTCUTS.some((s) => s.defaultChord.code === 'KeyS' && !s.defaultChord.alt)).toBe(false)
    expect(SHORTCUTS.some((s) => /save/i.test(s.label))).toBe(false)
  })

  it('marks the four directional cyclers, and only those, as CYCLE_IDS', () => {
    expect([...CYCLE_IDS].sort()).toEqual(
      ['next-terminal', 'next-worktree', 'prev-terminal', 'prev-worktree'],
    )
  })
})

describe('isShortcutId', () => {
  it('accepts known ids and rejects others', () => {
    expect(isShortcutId('new-worktree')).toBe(true)
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
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyN'))).toBe('new-worktree')
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyT'))).toBe('new-shell')
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyD'))).toBe('delete-worktree')
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyW'))).toBe('kill-terminal')
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyG'))).toBe('open-changes')
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyP'))).toBe('open-preview')
    expect(matchShortcut(DEFAULT_BINDINGS, key('Comma'))).toBe('view-tabs')
    expect(matchShortcut(DEFAULT_BINDINGS, key('Period'))).toBe('view-tiles')
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyK'))).toBe('prev-worktree')
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyJ'))).toBe('next-worktree')
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyH'))).toBe('prev-terminal')
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyL'))).toBe('next-terminal')
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyH', { shiftKey: true }))).toBe('move-terminal-left')
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyL', { shiftKey: true }))).toBe('move-terminal-right')
  })

  it('returns null for an unbound chord', () => {
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyM'))).toBeNull()
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyB'))).toBeNull()
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyN', { ctrlKey: true }))).toBeNull()
  })

  it('distinguishes the move commands from the cyclers by the Shift modifier', () => {
    // Alt+H is prev-terminal; the Shift variant is a different command.
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyH'))).toBe('prev-terminal')
    expect(matchShortcut(DEFAULT_BINDINGS, key('KeyH', { shiftKey: true }))).toBe('move-terminal-left')
  })

  it('honors a rebind', () => {
    const bindings = { ...DEFAULT_BINDINGS, 'new-worktree': chord('KeyY') }
    expect(matchShortcut(bindings, key('KeyY'))).toBe('new-worktree')
    expect(matchShortcut(bindings, key('KeyN'))).toBeNull()
  })
})

describe('cycleDeltaFor', () => {
  it('maps prev/next cyclers to -1/1 and non-cyclers to null', () => {
    expect(cycleDeltaFor('prev-worktree')).toBe(-1)
    expect(cycleDeltaFor('prev-terminal')).toBe(-1)
    expect(cycleDeltaFor('next-worktree')).toBe(1)
    expect(cycleDeltaFor('next-terminal')).toBe(1)
    expect(cycleDeltaFor('new-worktree')).toBeNull()
    expect(cycleDeltaFor('delete-worktree')).toBeNull()
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
    const r = validateChord(chord('AltLeft'), DEFAULT_BINDINGS, 'new-worktree')
    expect(r.ok).toBe(false)
  })

  it('requires a real modifier — Alt, Ctrl, or Meta', () => {
    expect(validateChord(chord('KeyY', { alt: false }), DEFAULT_BINDINGS, 'new-worktree').ok).toBe(false)
    // Shift alone is not enough.
    expect(validateChord(chord('KeyY', { alt: false, shift: true }), DEFAULT_BINDINGS, 'new-worktree').ok).toBe(false)
    expect(validateChord(chord('KeyY'), DEFAULT_BINDINGS, 'new-worktree').ok).toBe(true)
    expect(validateChord(chord('KeyY', { alt: false, ctrl: true }), DEFAULT_BINDINGS, 'new-worktree').ok).toBe(true)
  })

  it('rejects a chord already bound to a different command, with its label', () => {
    const r = validateChord(chord('KeyD'), DEFAULT_BINDINGS, 'new-worktree')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('Stop worktree')
  })

  it('refuses the platform’s save chord, and only that platform’s', () => {
    const cmdS = chord('KeyS', { alt: false, meta: true })
    const ctrlS = chord('KeyS', { alt: false, ctrl: true })
    const onMac = validateChord(cmdS, DEFAULT_BINDINGS, 'open-files', true)
    expect(onMac).toEqual({ ok: false, reason: 'Reserved for saving files.' })
    expect(validateChord(ctrlS, DEFAULT_BINDINGS, 'open-files', true).ok).toBe(true)
    expect(validateChord(ctrlS, DEFAULT_BINDINGS, 'open-files', false).ok).toBe(false)
    expect(validateChord(cmdS, DEFAULT_BINDINGS, 'open-files', false).ok).toBe(true)
    expect(saveChord(false)).toEqual(ctrlS)
  })

  it('refuses the platform’s find chord too', () => {
    expect(validateChord(chord('KeyF', { alt: false, meta: true }), DEFAULT_BINDINGS, 'open-files', true))
      .toEqual({ ok: false, reason: 'Reserved for find.' })
    expect(validateChord(chord('KeyF', { alt: false, ctrl: true }), DEFAULT_BINDINGS, 'open-files', true).ok)
      .toBe(true)
    expect(findChord(false)).toEqual(chord('KeyF', { alt: false, ctrl: true }))
  })

  it('refuses the text-size chords, and drops a stored override naming one', () => {
    for (const code of ['Equal', 'Minus', 'Digit0', 'NumpadAdd']) {
      expect(validateChord(chord(code, { alt: false, ctrl: true }), DEFAULT_BINDINGS, 'open-files', false))
        .toEqual({ ok: false, reason: 'Reserved for text size.' })
    }
    expect(validateChord(chord('Equal', { alt: false, ctrl: true, shift: true }), DEFAULT_BINDINGS, 'open-files', false).ok)
      .toBe(false)
    expect(validateChord(chord('Equal', { alt: false, ctrl: true }), DEFAULT_BINDINGS, 'open-files', true).ok).toBe(true)
    expect(mergeBindings({ 'open-files': chord('Minus', { alt: false, meta: true }) }, true)['open-files'])
      .toEqual(DEFAULT_BINDINGS['open-files'])
  })

  it('reads the text-size keys by character, so they follow the layout', () => {
    const ctrl = { altKey: false, ctrlKey: true, metaKey: false }
    expect(textSizeStep({ ...ctrl, key: '=' }, false)).toBe(1)
    expect(textSizeStep({ ...ctrl, key: '+' }, false)).toBe(1) // QWERTZ, or Shift+=
    expect(textSizeStep({ ...ctrl, key: '-' }, false)).toBe(-1) // AZERTY's Digit6
    expect(textSizeStep({ ...ctrl, key: '0' }, false)).toBe(0)
    expect(textSizeStep({ ...ctrl, key: 'ß' }, false)).toBeNull() // QWERTZ's Minus key
    expect(textSizeStep({ ...ctrl, key: '=', altKey: true }, false)).toBeNull()
    expect(textSizeStep({ ...ctrl, key: '=' }, true)).toBeNull() // Cmd on a Mac, not Ctrl
    expect(textSizeStep({ altKey: false, ctrlKey: false, metaKey: true, key: '=' }, true)).toBe(1)
  })

  it('allows rebinding a command to its own current chord', () => {
    expect(validateChord(chord('KeyN'), DEFAULT_BINDINGS, 'new-worktree').ok).toBe(true)
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
      'new-worktree': chord('KeyY'),
      'bogus-id': chord('KeyZ'),
      'kill-terminal': { code: 'KeyW' }, // malformed — dropped
    })
    expect(merged['new-worktree']).toEqual(chord('KeyY'))
    expect(merged['kill-terminal']).toEqual(DEFAULT_BINDINGS['kill-terminal'])
    expect((merged as Record<string, unknown>)['bogus-id']).toBeUndefined()
  })

  it('drops an override that claims a reserved chord', () => {
    const merged = mergeBindings({
      'open-files': chord('KeyS', { alt: false, ctrl: true }),
      'new-shell': chord('KeyF', { alt: false, ctrl: true }),
      'open-changes': chord('KeyS', { alt: false, meta: true }),
    }, false)
    expect(merged['open-files']).toEqual(DEFAULT_BINDINGS['open-files'])
    expect(merged['new-shell']).toEqual(DEFAULT_BINDINGS['new-shell'])
    // Cmd+S is not the save chord off macOS, so that one stands.
    expect(merged['open-changes']).toEqual(chord('KeyS', { alt: false, meta: true }))
  })

  it('lets an override win over a default it collides with, leaving that command unbound', () => {
    // Alt+T / Alt+G became the new-shell / open-changes defaults after
    // overrides on them could already have been saved.
    const merged = mergeBindings({ 'new-worktree': chord('KeyT'), 'view-tiles': chord('KeyG') })
    expect(merged['new-shell']).toEqual(UNBOUND)
    expect(merged['open-changes']).toEqual(UNBOUND)
    expect(matchShortcut(merged, key('KeyT'))).toBe('new-worktree')
    expect(matchShortcut(merged, key('KeyG'))).toBe('view-tiles')
    // An unbound command matches nothing, even a keydown with an empty code.
    expect(matchShortcut(merged, key('', { altKey: false }))).toBeNull()
    expect(formatChord(UNBOUND)).toBe('Unset')
    // Two overrides never unbind each other's (overridden) command.
    expect(mergeBindings({ 'new-shell': chord('KeyY'), 'new-worktree': chord('KeyT') })['new-shell'])
      .toEqual(chord('KeyY'))
  })

  it('takes a stored override of open-files over its Alt+E default', () => {
    const merged = mergeBindings({ 'open-files': chord('KeyO', { shift: true }) })
    expect(matchShortcut(merged, key('KeyO', { shiftKey: true }))).toBe('open-files')
    expect(matchShortcut(merged, key('KeyE'))).toBeNull()
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
    expect(formatCode('Comma')).toBe(',')
    expect(formatCode('Period')).toBe('.')
    expect(formatCode('F5')).toBe('F5') // unknown → raw code
  })
})

describe('formatChord', () => {
  it('renders modifier+key with +-separators off mac', () => {
    expect(formatChord(chord('KeyN'))).toBe('Alt+N')
    expect(formatChord(chord('KeyK', { alt: false, ctrl: true, shift: true }))).toBe('Ctrl+Shift+K')
    expect(formatChord(chord('KeyH', { shift: true }))).toBe('Alt+Shift+H')
    expect(formatChord(chord('Comma'))).toBe('Alt+,')
    expect(formatChord(chord('ArrowRight'))).toBe('Alt+→')
  })

  it('uses the platform glyphs on mac', () => {
    expect(formatChord(chord('KeyN'), true)).toBe('⌥N')
    expect(formatChord(chord('KeyK', { alt: false, ctrl: true, meta: true }), true)).toBe('⌃⌘K')
  })
})
