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
 * The theme actually in effect (light or dark), resolving 'system' against the
 * OS. Reads the live <html data-theme> the CSS keys off, so callers that can't
 * see CSS variables — e.g. the xterm canvas, which needs concrete colors —
 * stay in sync with the rest of the UI. Defaults to dark when the OS
 * preference can't be read.
 */
export function resolveEffectiveTheme(): 'light' | 'dark' {
  const attr = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null
  if (attr === 'light' || attr === 'dark') return attr
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'dark'
}
