/**
 * Light/dark theme preference. 'system' follows the OS appearance (via the
 * `prefers-color-scheme` media query in index.css); 'light'/'dark' force one.
 * The choice is a `data-theme` attribute on <html> that the CSS keys off, plus
 * a localStorage entry so it survives reloads (and is read by the no-flash
 * inline script in index.html before first paint).
 */
export type ThemePref = 'system' | 'light' | 'dark'

const THEME_LS_KEY = 'yaac.theme.v1'

/** Persisted theme preference; defaults to 'system' when unset or unreadable. */
export function loadThemePref(): ThemePref {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(THEME_LS_KEY)
      if (raw === 'system' || raw === 'light' || raw === 'dark') return raw
    }
  } catch { /* fall through to the default */ }
  return 'system'
}

/** Persist the theme preference (best-effort — a failed write just means the
 *  default applies next launch). */
export function persistThemePref(pref: ThemePref): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_LS_KEY, pref)
  } catch { /* quota/serialization failures are non-fatal */ }
}

/** Reflect the preference onto <html data-theme> so the CSS palette switches.
 *  Exported (with an injectable root) so it's unit-testable. */
export function applyThemeAttribute(pref: ThemePref, root?: HTMLElement): void {
  const el = root ?? (typeof document !== 'undefined' ? document.documentElement : null)
  if (el) el.setAttribute('data-theme', pref)
}

/**
 * The theme actually in effect (light or dark), for callers that can't see CSS
 * variables — e.g. the xterm canvas, which needs concrete colors. Derived from
 * the app's *rendered* --color-bg rather than re-resolving data-theme + the OS:
 * in Electron matchMedia can disagree with the CSS media query, which would
 * leak the light terminal into a dark app. Reading the applied background can't
 * disagree with what the UI shows. Defaults to dark when it can't be read.
 */
export function resolveEffectiveTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return 'dark'
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim()
  return isLightColor(bg) ? 'light' : 'dark'
}

/** Whether a `#rgb`/`#rrggbb` color is light (perceived luminance > 0.5). */
function isLightColor(hex: string): boolean {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex)
  if (!m) return false
  const h = m[1].length === 3 ? m[1].replace(/(.)/g, '$1$1') : m[1]
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5
}
