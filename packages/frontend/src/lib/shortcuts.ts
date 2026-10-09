import { IS_MAC } from '#lib/platform'

/** Cycling direction decoded from a workspace keydown:
 *  -1 = previous (left/up), 1 = next (right/down). */
export type CycleDelta = 1 | -1

/** The keyboard-event fields matching needs, so tests need not build a full
 *  KeyboardEvent. */
export type ShortcutKey = Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'code'>

/**
 * A normalized key chord: a physical key plus the four modifier states.
 * Matched on `code` (the physical key) rather than `key` so macOS Option
 * dead-keys ("˜", "†") and keyboard-layout differences never affect it.
 */
export interface Chord {
  code: string
  alt: boolean
  ctrl: boolean
  meta: boolean
  shift: boolean
}

/**
 * The rebindable commands. Directional commands have one id per direction
 * so each can be rebound separately.
 */
export type ShortcutId =
  | 'new-workspace'
  | 'new-shell'
  | 'delete-workspace'
  | 'kill-terminal'
  | 'open-changes'
  | 'open-files'
  | 'open-preview'
  | 'view-tabs'
  | 'view-tiles'
  | 'prev-workspace'
  | 'next-workspace'
  | 'prev-terminal'
  | 'next-terminal'
  | 'move-terminal-left'
  | 'move-terminal-right'

/** A command's identity, human labels, and factory-default chord. */
export interface ShortcutDef {
  id: ShortcutId
  label: string
  description: string
  defaultChord: Chord
}

/** The resolved chord bound to every command. */
export type BindingMap = Record<ShortcutId, Chord>

/** Alt plus a physical key: the usual default. */
function alt(code: string): Chord {
  return { code, alt: true, ctrl: false, meta: false, shift: false }
}

/** Alt+Shift plus a physical key: the "move" commands' default. */
function altShift(code: string): Chord {
  return { code, alt: true, ctrl: false, meta: false, shift: true }
}

/**
 * The command registry, in match-precedence and display order. Labels and
 * descriptions appear in Settings → Shortcuts. Directional defaults use
 * vim's h/j/k/l, leaving the arrow keys to the terminal.
 */
export const SHORTCUTS: ShortcutDef[] = [
  { id: 'new-workspace', label: 'New workspace',
    description: 'Open the create dialog in the active project, prompt focused.', defaultChord: alt('KeyN') },
  { id: 'new-shell', label: 'New shell',
    description: 'Open a scratch-shell terminal in the selected workspace.', defaultChord: alt('KeyT') },
  { id: 'delete-workspace', label: 'Stop workspace',
    description: 'Stop the selected workspace (asks to confirm).', defaultChord: alt('KeyD') },
  { id: 'kill-terminal', label: 'Kill terminal',
    description: 'Close the active terminal (asks to confirm).', defaultChord: alt('KeyW') },
  { id: 'open-changes', label: 'Open changes',
    description: 'Open the changed files and their diffs, and focus their filter.', defaultChord: alt('KeyG') },
  { id: 'open-files', label: 'Open file tree',
    description: 'Open the file tree and focus its filter.', defaultChord: alt('KeyE') },
  { id: 'open-preview', label: 'Open preview',
    description: 'Open the preview pane for a forwarded port.', defaultChord: alt('KeyP') },
  { id: 'view-tabs', label: 'Tabbed view',
    description: 'Show the workspace as one tab strip.', defaultChord: alt('Comma') },
  { id: 'view-tiles', label: 'Window view',
    description: 'Show the workspace as side-by-side windows.', defaultChord: alt('Period') },
  { id: 'prev-workspace', label: 'Previous workspace',
    description: 'Select the previous workspace in the sidebar.', defaultChord: alt('KeyK') },
  { id: 'next-workspace', label: 'Next workspace',
    description: 'Select the next workspace in the sidebar.', defaultChord: alt('KeyJ') },
  { id: 'prev-terminal', label: 'Previous terminal',
    description: 'Focus the previous terminal in the tab strip.', defaultChord: alt('KeyH') },
  { id: 'next-terminal', label: 'Next terminal',
    description: 'Focus the next terminal in the tab strip.', defaultChord: alt('KeyL') },
  { id: 'move-terminal-left', label: 'Move terminal left',
    description: 'Move the active terminal left (its window in tiles mode), wrapping around.',
    defaultChord: altShift('KeyH') },
  { id: 'move-terminal-right', label: 'Move terminal right',
    description: 'Move the active terminal right (its window in tiles mode), wrapping around.',
    defaultChord: altShift('KeyL') },
]

/** All shortcut ids, in registry order. */
const SHORTCUT_IDS: ShortcutId[] = SHORTCUTS.map((s) => s.id)

/** The factory-default binding for every command. */
export const DEFAULT_BINDINGS: BindingMap = Object.fromEntries(
  SHORTCUTS.map((s) => [s.id, s.defaultChord]),
) as BindingMap

/**
 * The four cycle commands. The terminal lets these chords bubble to the
 * window listeners instead of sending them to the PTY.
 */
export const CYCLE_IDS: ReadonlySet<ShortcutId> = new Set<ShortcutId>([
  'prev-workspace', 'next-workspace', 'prev-terminal', 'next-terminal',
])

/** True when `id` is one of the known rebindable commands. */
export function isShortcutId(id: string): id is ShortcutId {
  return SHORTCUT_IDS.includes(id as ShortcutId)
}

/** Normalize a keydown into a Chord. */
export function chordFromEvent(e: ShortcutKey): Chord {
  return { code: e.code, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey }
}

/** Structural chord equality. */
export function chordsEqual(a: Chord, b: Chord): boolean {
  return a.code === b.code
    && a.alt === b.alt
    && a.ctrl === b.ctrl
    && a.meta === b.meta
    && a.shift === b.shift
}

/** No chord, left by `mergeBindings` when an override takes a command's
 *  default. Its empty `code` never matches. */
export const UNBOUND: Chord = { code: '', alt: false, ctrl: false, meta: false, shift: false }

/**
 * True when a keydown matches a chord exactly: the same physical key and
 * the same four modifiers. Exact matching lets AltGr (reported as Ctrl+Alt)
 * characters through an Alt-only chord.
 */
export function chordMatches(binding: Chord, e: ShortcutKey): boolean {
  return binding.code !== ''
    && e.code === binding.code
    && e.altKey === binding.alt
    && e.ctrlKey === binding.ctrl
    && e.metaKey === binding.meta
    && e.shiftKey === binding.shift
}

/**
 * The command a keydown triggers, or null to let it through. Validation
 * keeps chords unique, so at most one matches.
 */
export function matchShortcut(bindings: BindingMap, e: ShortcutKey): ShortcutId | null {
  for (const id of SHORTCUT_IDS) {
    if (chordMatches(bindings[id], e)) return id
  }
  return null
}

/**
 * Consume a matched chord's keydown so nothing else (xterm, the browser)
 * acts on it.
 *
 * On macOS an Option chord on a dead key (Option+N is `˜` on a US layout)
 * still sends its accent as a composition, which preventDefault can't stop,
 * and it lands in whatever field the command just focused. Such a keydown
 * has `key === 'Dead'`; a composition that starts before the next key event
 * is discarded.
 */
export function claimChord(e: KeyboardEvent): void {
  e.preventDefault()
  e.stopPropagation()
  if (e.key !== 'Dead') return
  deadChord = e
  if (straysWatched) return
  straysWatched = true
  // Chrome sends the accent before the chord's keyup, or not at all when
  // nothing editable has focus, so the next key event ends the wait.
  for (const type of ['keydown', 'keyup']) {
    window.addEventListener(type, (k) => { if (k !== deadChord) deadChord = null }, true)
  }
  window.addEventListener('compositionstart', discardStray, true)
  // Hide the accent's events from the field's handlers (React, xterm).
  for (const type of ['compositionupdate', 'compositionend', 'beforeinput', 'input', 'change']) {
    window.addEventListener(type, (ev) => { if (ev.target === stray) ev.stopImmediatePropagation() }, true)
  }
}

let straysWatched = false
/** The dead-key chord whose accent is still to come. */
let deadChord: KeyboardEvent | null = null
/** The field the accent landed in, until it is removed. */
let stray: EventTarget | null = null

function discardStray(e: Event): void {
  if (deadChord === null) return
  deadChord = null
  const el = e.target
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return
  e.stopImmediatePropagation()
  stray = el
  const { value, selectionStart, selectionEnd } = el
  // After the composition lands, blur to make Chrome drop it, then restore
  // the field's value and selection.
  setTimeout(() => {
    const focused = document.activeElement === el
    el.blur()
    el.value = value
    el.setSelectionRange(selectionStart, selectionEnd)
    if (focused) el.focus()
    stray = null
  })
}

/** The cycle direction a command implies, or null if it isn't a cycler. */
export function cycleDeltaFor(id: ShortcutId): CycleDelta | null {
  if (id === 'prev-workspace' || id === 'prev-terminal') return -1
  if (id === 'next-workspace' || id === 'next-terminal') return 1
  return null
}

/**
 * The target a cycle lands on, given the candidates in display order and the
 * active one. Wraps at both ends; with no valid active target it starts from
 * the end it is heading toward. Null when the list is empty.
 */
export function resolveCycleTarget(
  targets: string[],
  active: string | undefined,
  delta: CycleDelta,
): string | null {
  if (targets.length === 0) return null
  const current = active ? targets.indexOf(active) : -1
  if (current === -1) return delta === 1 ? targets[0] : targets[targets.length - 1]
  return targets[(current + delta + targets.length) % targets.length]
}

/** Physical `code` values of the modifier keys themselves. */
const MODIFIER_CODES = new Set<string>([
  'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight',
  'MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight',
])

/** True when `code` is a bare modifier key rather than a bindable key. */
export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code)
}

/** Cmd on macOS, Ctrl elsewhere, plus a physical key. */
function platformChord(code: string, isMac: boolean): Chord {
  return { code, alt: false, ctrl: !isMac, meta: isMac, shift: false }
}

/**
 * Fixed chords the panes handle themselves: Cmd/Ctrl-S saves a file,
 * Cmd/Ctrl-F opens find in a file pane or a conversation, and Cmd/Ctrl
 * =/−/0 resize text (textSizeStep). They can't be rebound and are reserved, since
 * the shortcut listener runs before the panes and would swallow them.
 */
export function saveChord(isMac = IS_MAC): Chord {
  return platformChord('KeyS', isMac)
}
export function findChord(isMac = IS_MAC): Chord {
  return platformChord('KeyF', isMac)
}


/**
 * The editors' text-size keys: Cmd/Ctrl with = or + steps up, − steps down,
 * 0 resets; null otherwise. Matched on the character, not the physical key,
 * so the +/− keys work on every layout.
 */
export function textSizeStep(
  e: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'key'>,
  isMac = IS_MAC,
): 1 | -1 | 0 | null {
  if (e.altKey || !(isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return null
  switch (e.key) {
    case '=': case '+': return 1
    case '-': return -1
    case '0': return 0
    default: return null
  }
}
/** textSizeStep's keys as US-layout codes, for reserving chords. */
const TEXT_SIZE_CODES = new Set(['Equal', 'Minus', 'Digit0', 'NumpadAdd', 'NumpadSubtract', 'Numpad0'])

/** What a reserved chord is kept for, or null when `chord` is free. */
function reservedFor(chord: Chord, isMac: boolean): string | null {
  if (chordsEqual(chord, saveChord(isMac))) return 'saving files'
  if (chordsEqual(chord, findChord(isMac))) return 'find'
  const mod = isMac ? chord.meta && !chord.ctrl : chord.ctrl && !chord.meta
  if (mod && !chord.alt && TEXT_SIZE_CODES.has(chord.code)) return 'text size'
  return null
}

/** The outcome of validating a candidate rebind. */
export type ChordValidation = { ok: true } | { ok: false; reason: string }

/**
 * Whether `chord` may be bound to `selfId`. Requires Alt, Ctrl or Meta so a
 * bare key can't shadow typing, and rejects a lone modifier, a reserved
 * chord, and a chord bound to another command.
 */
export function validateChord(
  chord: Chord,
  bindings: BindingMap,
  selfId: ShortcutId,
  isMac = IS_MAC,
): ChordValidation {
  if (isModifierCode(chord.code)) {
    return { ok: false, reason: 'Press a key along with a modifier.' }
  }
  if (!chord.alt && !chord.ctrl && !chord.meta) {
    return { ok: false, reason: 'Hold Alt, Ctrl, or Cmd.' }
  }
  const reserved = reservedFor(chord, isMac)
  if (reserved) return { ok: false, reason: `Reserved for ${reserved}.` }
  for (const id of SHORTCUT_IDS) {
    if (id === selfId) continue
    if (chordsEqual(bindings[id], chord)) {
      const def = SHORTCUTS.find((s) => s.id === id)
      return { ok: false, reason: `Already bound to “${def?.label ?? id}”.` }
    }
  }
  return { ok: true }
}

/** Runtime check for a Chord, since overrides arrive as JSON. */
export function isChord(value: unknown): value is Chord {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  return typeof c.code === 'string'
    && typeof c.alt === 'boolean'
    && typeof c.ctrl === 'boolean'
    && typeof c.meta === 'boolean'
    && typeof c.shift === 'boolean'
}

/**
 * The defaults overlaid with `overrides`. Unknown ids, malformed chords and
 * reserved chords (possible in a stale or hand-edited file) are ignored.
 *
 * An override wins over another command's default that uses the same chord;
 * that command is left UNBOUND and Settings shows it as unset.
 */
export function mergeBindings(overrides: Record<string, unknown>, isMac = IS_MAC): BindingMap {
  const merged: BindingMap = { ...DEFAULT_BINDINGS }
  const overridden = new Set<ShortcutId>()
  for (const [id, chord] of Object.entries(overrides)) {
    if (isShortcutId(id) && isChord(chord) && !reservedFor(chord, isMac)) {
      merged[id] = chord
      overridden.add(id)
    }
  }
  for (const id of SHORTCUT_IDS) {
    if (overridden.has(id)) continue
    if ([...overridden].some((o) => chordsEqual(merged[o], merged[id]))) merged[id] = UNBOUND
  }
  return merged
}

/** A human label for a physical `code`: KeyN→N, Digit1→1, ArrowLeft→←, else
 *  the raw code. */
export function formatCode(code: string): string {
  const named: Record<string, string> = {
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    Enter: 'Enter', Escape: 'Esc', Space: 'Space', Tab: 'Tab',
    Backspace: 'Backspace', Delete: 'Delete', Comma: ',', Period: '.',
  }
  if (code in named) return named[code]
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  return code
}

/**
 * Render a chord for display, e.g. "Alt+N", "Ctrl+Shift+K", "Alt+→". On macOS
 * uses the platform glyphs (⌃ ⌥ ⇧ ⌘) in their conventional order.
 */
export function formatChord(chord: Chord, isMac = false): string {
  if (chord.code === '') return 'Unset'
  if (isMac) {
    let out = ''
    if (chord.ctrl) out += '⌃'
    if (chord.alt) out += '⌥'
    if (chord.shift) out += '⇧'
    if (chord.meta) out += '⌘'
    return out + formatCode(chord.code)
  }
  const parts: string[] = []
  if (chord.ctrl) parts.push('Ctrl')
  if (chord.meta) parts.push('Meta')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push(formatCode(chord.code))
  return parts.join('+')
}
