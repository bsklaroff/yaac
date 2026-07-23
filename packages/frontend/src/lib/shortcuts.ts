/** Cycling direction decoded from a workspace keydown:
 *  -1 = previous (left/up), 1 = next (right/down). */
export type CycleDelta = 1 | -1

/** Just the keyboard-event fields matching needs — keeps the matchers pure and
 *  trivial to unit test without synthesizing a full KeyboardEvent. */
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
 * The rebindable commands. The directional cycles are split into prev/next so
 * each direction is independently editable in the settings pane; the move
 * commands likewise split into left/right.
 */
export type ShortcutId =
  | 'new-session'
  | 'new-shell'
  | 'delete-session'
  | 'kill-terminal'
  | 'jump-attention'
  | 'open-changes'
  | 'find-changes'
  | 'open-preview'
  | 'view-tabs'
  | 'view-tiles'
  | 'prev-session'
  | 'next-session'
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

/** Alt-only chord for a physical key — the historical default shape. */
function alt(code: string): Chord {
  return { code, alt: true, ctrl: false, meta: false, shift: false }
}

/** Alt+Shift chord for a physical key — the "move" commands' default shape. */
function altShift(code: string): Chord {
  return { code, alt: true, ctrl: false, meta: false, shift: true }
}

/**
 * The command registry, in match-precedence and display order. Labels and
 * descriptions surface in Settings → Shortcuts. The directional defaults are
 * the vim-style home-row keys (h/j/k/l), leaving the arrow keys free for the
 * terminal.
 */
export const SHORTCUTS: ShortcutDef[] = [
  { id: 'new-session', label: 'New session',
    description: 'Create a session in the active project.', defaultChord: alt('KeyN') },
  { id: 'new-shell', label: 'New shell',
    description: 'Open a scratch-shell terminal in the selected session.', defaultChord: alt('KeyS') },
  { id: 'delete-session', label: 'Delete session',
    description: 'Delete the selected session (asks to confirm).', defaultChord: alt('KeyD') },
  { id: 'kill-terminal', label: 'Kill terminal',
    description: 'Close the active terminal (asks to confirm).', defaultChord: alt('KeyW') },
  { id: 'jump-attention', label: 'Jump to attention',
    description: 'Select the session that most needs attention.', defaultChord: alt('KeyB') },
  { id: 'open-changes', label: 'Open changes',
    description: 'Open the Changes (review-diff) pane.', defaultChord: alt('KeyC') },
  { id: 'find-changes', label: 'Find in changes',
    description: 'Open the Changes pane and focus its find box.', defaultChord: alt('KeyF') },
  { id: 'open-preview', label: 'Open preview',
    description: 'Open the preview pane for a forwarded port.', defaultChord: alt('KeyP') },
  { id: 'view-tabs', label: 'Tabbed view',
    description: 'Show the workspace as one tab strip.', defaultChord: alt('Comma') },
  { id: 'view-tiles', label: 'Window view',
    description: 'Show the workspace as side-by-side windows.', defaultChord: alt('Period') },
  { id: 'prev-session', label: 'Previous session',
    description: 'Select the previous session in the sidebar.', defaultChord: alt('KeyK') },
  { id: 'next-session', label: 'Next session',
    description: 'Select the next session in the sidebar.', defaultChord: alt('KeyJ') },
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

/** All shortcut ids, in registry order (which is also match precedence). */
const SHORTCUT_IDS: ShortcutId[] = SHORTCUTS.map((s) => s.id)

/** The factory-default binding for every command. */
export const DEFAULT_BINDINGS: BindingMap = Object.fromEntries(
  SHORTCUTS.map((s) => [s.id, s.defaultChord]),
) as BindingMap

/**
 * The four directional cycle commands. The workspace owns these chords, so the
 * terminal lets them bubble to the window listeners instead of forwarding ESC
 * bytes to the PTY.
 */
export const CYCLE_IDS: ReadonlySet<ShortcutId> = new Set<ShortcutId>([
  'prev-session', 'next-session', 'prev-terminal', 'next-terminal',
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

/**
 * True when a keydown exactly matches a bound chord — the same physical key and
 * the same four modifier states. Exact modifier equality is what preserves
 * AltGr passthrough for free: a chord bound to Alt-alone won't match a Ctrl+Alt
 * event (AltGr), because `ctrl` differs, so those characters fall through
 * untouched.
 */
export function chordMatches(binding: Chord, e: ShortcutKey): boolean {
  return e.code === binding.code
    && e.altKey === binding.alt
    && e.ctrlKey === binding.ctrl
    && e.metaKey === binding.meta
    && e.shiftKey === binding.shift
}

/**
 * The command a keydown triggers under the given bindings, or null for
 * "not ours — let it through". First match in registry order wins (validation
 * keeps two commands from sharing a chord, so at most one ever matches).
 */
export function matchShortcut(bindings: BindingMap, e: ShortcutKey): ShortcutId | null {
  for (const id of SHORTCUT_IDS) {
    if (chordMatches(bindings[id], e)) return id
  }
  return null
}

/** The cycle direction a command implies, or null if it isn't a cycler. */
export function cycleDeltaFor(id: ShortcutId): CycleDelta | null {
  if (id === 'prev-session' || id === 'prev-terminal') return -1
  if (id === 'next-session' || id === 'next-terminal') return 1
  return null
}

/**
 * The target a cycle lands on, given the candidates in display order (the
 * workspace's terminals in tab-strip order, or the sidebar's session rows
 * top-to-bottom) and the currently active one. Wraps at both ends; with no
 * (valid) active target it enters the list from the end it's headed toward.
 * Null when there's nothing to switch to.
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

/** Physical `code` values that are modifier keys themselves — a chord can't be
 *  a bare modifier. */
const MODIFIER_CODES = new Set<string>([
  'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight',
  'MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight',
])

/** True when `code` is a bare modifier key rather than a bindable key. */
export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code)
}

/** The outcome of validating a candidate rebind. */
export type ChordValidation = { ok: true } | { ok: false; reason: string }

/**
 * Whether `chord` may be bound to `selfId`. Requires a real modifier
 * (Alt/Ctrl/Meta) so a bare key can't shadow terminal typing, rejects a lone
 * modifier keypress, and rejects a chord already bound to a different command.
 */
export function validateChord(chord: Chord, bindings: BindingMap, selfId: ShortcutId): ChordValidation {
  if (isModifierCode(chord.code)) {
    return { ok: false, reason: 'Press a key along with a modifier.' }
  }
  if (!chord.alt && !chord.ctrl && !chord.meta) {
    return { ok: false, reason: 'Hold Alt, Ctrl, or Cmd.' }
  }
  for (const id of SHORTCUT_IDS) {
    if (id === selfId) continue
    if (chordsEqual(bindings[id], chord)) {
      const def = SHORTCUTS.find((s) => s.id === id)
      return { ok: false, reason: `Already bound to “${def?.label ?? id}”.` }
    }
  }
  return { ok: true }
}

/** Runtime guard for a Chord shape — overrides arrive from JSON. */
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
 * A binding map = the defaults overlaid with `overrides`, but only for known
 * ids carrying a well-formed chord. Unknown ids and malformed chords (both
 * possible when reading a hand-edited or stale preferences file) are ignored.
 */
export function mergeBindings(overrides: Record<string, unknown>): BindingMap {
  const merged: BindingMap = { ...DEFAULT_BINDINGS }
  for (const [id, chord] of Object.entries(overrides)) {
    if (isShortcutId(id) && isChord(chord)) merged[id] = chord
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
