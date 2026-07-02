/** Terminal-cycling direction decoded from a workspace keydown:
 *  -1 = previous (left), 1 = next (right). */
export type CycleDelta = 1 | -1

/** Just the keyboard-event fields the decision needs — keeps this pure and
 *  trivial to unit test without synthesizing a full KeyboardEvent. */
export type ShortcutKey = Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'code'>

/**
 * Map a keydown to a terminal-switching intent:
 *
 *  - Alt+← / Alt+→ — previous / next terminal (tab-strip order),
 *    the same chord on every platform.
 *
 * Alt+arrows are page-interceptable in every browser — unlike the
 * reserved native tab chords (⌘1-9, Ctrl+Tab, ⌘⇧[/]) — and AltGr layouts
 * are unaffected (AltGr reports Ctrl+Alt, which doesn't match). Accepted
 * costs: inside terminal panes this shadows ⌥←/⌥→ word-jump on macOS,
 * and it swallows the browser's Alt+←/→ history navigation while the
 * workspace is open.
 *
 * Returns null for anything else, meaning "not ours — let it through".
 */
export function matchTabShortcut(e: ShortcutKey): CycleDelta | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null
  if (e.code === 'ArrowLeft') return -1
  if (e.code === 'ArrowRight') return 1
  return null
}

/**
 * The target a cycle lands on, given the workspace's terminals in tab-strip
 * order and the currently active one. Wraps at both ends; with no (valid)
 * active terminal it enters the list from the end it's headed toward. Null
 * when there's nothing to switch to.
 */
export function resolveTabShortcut(
  targets: string[],
  active: string | undefined,
  delta: CycleDelta,
): string | null {
  if (targets.length === 0) return null
  const current = active ? targets.indexOf(active) : -1
  if (current === -1) return delta === 1 ? targets[0] : targets[targets.length - 1]
  return targets[(current + delta + targets.length) % targets.length]
}
