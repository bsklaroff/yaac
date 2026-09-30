/** True when the SPA is running inside the Electron desktop shell (vs a browser). */
export function isElectron(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron')
}

/** True on Apple platforms, where shortcuts use Cmd and are drawn with ⌘ ⌥.
 *  iPadOS Safari reports "Macintosh", which is the right treatment. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
