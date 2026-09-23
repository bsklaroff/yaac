import { IS_MAC } from '#lib/platform'

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
  | 'new-worktree'
  | 'new-shell'
  | 'delete-worktree'
  | 'kill-terminal'
  | 'open-changes'
  | 'open-files'
  | 'open-preview'
  | 'view-tabs'
  | 'view-tiles'
  | 'prev-worktree'
  | 'next-worktree'
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
  { id: 'new-worktree', label: 'New worktree',
    description: 'Create a worktree in the active project.', defaultChord: alt('KeyN') },
  { id: 'new-shell', label: 'New shell',
    description: 'Open a scratch-shell terminal in the selected worktree.', defaultChord: alt('KeyT') },
  { id: 'delete-worktree', label: 'Stop worktree',
    description: 'Stop the selected worktree (asks to confirm).', defaultChord: alt('KeyD') },
  { id: 'kill-terminal', label: 'Kill terminal',
    description: 'Close the active terminal (asks to confirm).', defaultChord: alt('KeyW') },
  { id: 'open-changes', label: 'Open changes',
    description: 'Open the Changes (review-diff) pane.', defaultChord: alt('KeyG') },
  { id: 'open-files', label: 'Open file tree',
    description: 'Open the file tree and focus its filter.', defaultChord: alt('KeyE') },
  { id: 'open-preview', label: 'Open preview',
    description: 'Open the preview pane for a forwarded port.', defaultChord: alt('KeyP') },
  { id: 'view-tabs', label: 'Tabbed view',
    description: 'Show the workspace as one tab strip.', defaultChord: alt('Comma') },
  { id: 'view-tiles', label: 'Window view',
    description: 'Show the workspace as side-by-side windows.', defaultChord: alt('Period') },
  { id: 'prev-worktree', label: 'Previous worktree',
    description: 'Select the previous worktree in the sidebar.', defaultChord: alt('KeyK') },
  { id: 'next-worktree', label: 'Next worktree',
    description: 'Select the next worktree in the sidebar.', defaultChord: alt('KeyJ') },
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
  'prev-worktree', 'next-worktree', 'prev-terminal', 'next-terminal',
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

/** A command with no chord: what `mergeBindings` leaves when a saved override
 *  claims the command's default. Its empty `code` never matches a keydown. */
export const UNBOUND: Chord = { code: '', alt: false, ctrl: false, meta: false, shift: false }

/**
 * True when a keydown exactly matches a bound chord — the same physical key and
 * the same four modifier states. Exact modifier equality is what preserves
 * AltGr passthrough for free: a chord bound to Alt-alone won't match a Ctrl+Alt
 * event (AltGr), because `ctrl` differs, so those characters fall through
 * untouched.
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
  if (id === 'prev-worktree' || id === 'prev-terminal') return -1
  if (id === 'next-worktree' || id === 'next-terminal') return 1
  return null
}

/**
 * The target a cycle lands on, given the candidates in display order (the
 * workspace's terminals in tab-strip order, or the sidebar's worktree rows
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

/** Cmd on macOS, Ctrl elsewhere, plus a physical key. */
function platformChord(code: string, isMac: boolean): Chord {
  return { code, alt: false, ctrl: !isMac, meta: isMac, shift: false }
}

/**
 * The fixed chords a pane handles on its own root: Cmd/Ctrl-S saves in the
 * file pane, Cmd/Ctrl-F opens the file pane's find bar or jumps to the
 * Changes pane's find box, and Cmd/Ctrl =/−/0 size the file pane's text
 * (textSizeStep). None is a registry command — each is part of what its
 * pane is — so they are never rebindable, and they are reserved: the
 * workspace's shortcut listener runs ahead of the panes, so a command bound
 * to one would swallow it.
 */
export function saveChord(isMac = IS_MAC): Chord {
  return platformChord('KeyS', isMac)
}
export function findChord(isMac = IS_MAC): Chord {
  return platformChord('KeyF', isMac)
}


/**
 * The text-size keys every editor shares: Cmd/Ctrl with = or + a step up,
 * − a step down, 0 back to the default; null for anything else. Matched on
 * the character, not the physical key, so the keys labelled +/− work on
 * every layout (on QWERTZ `+` is BracketRight, on AZERTY `-` is Digit6).
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
/** Where textSizeStep's keys sit on a US layout — what a chord can name. */
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
 * Whether `chord` may be bound to `selfId`. Requires a real modifier
 * (Alt/Ctrl/Meta) so a bare key can't shadow terminal typing, rejects a lone
 * modifier keypress, a reserved chord (save, find), and a chord already bound
 * to a different command.
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
 * ids carrying a well-formed chord that is not reserved. Unknown ids,
 * malformed chords and a claim on a reserved chord (all possible when reading
 * a hand-edited or stale preferences file) are ignored.
 *
 * An override outranks another command's default it collides with (the
 * default may be newer than the override): that command is left UNBOUND, so
 * the user's own choice keeps working and Settings shows the other as unset.
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
