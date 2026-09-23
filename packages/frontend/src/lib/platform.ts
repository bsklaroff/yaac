/** True when the SPA is running inside the Electron desktop shell (vs a browser). */
export function isElectron(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron')
}

/** True on Apple platforms: where saving is Cmd-S rather than Ctrl-S, and
 *  chords are drawn with the ⌘ ⌥ glyphs. iPadOS reports as "Macintosh" in
 *  modern Safari, which is what it should be treated as. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
