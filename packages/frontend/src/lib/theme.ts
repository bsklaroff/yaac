/**
 * Light/dark theme preference. 'system' follows the OS appearance (via the
 * `prefers-color-scheme` media query in index.css); 'light'/'dark' force one.
 * The choice is set as a `data-theme` attribute on <html> for the CSS. The
 * store saves it (`themePref` in lib/store.ts), where the inline script in
 * index.html reads it before first paint to avoid a flash.
 */
export type ThemePref = 'system' | 'light' | 'dark'

/** Set <html data-theme> so the CSS palette switches. `root` is for tests. */
export function applyThemeAttribute(pref: ThemePref, root?: HTMLElement): void {
  const el = root ?? (typeof document !== 'undefined' ? document.documentElement : null)
  if (el) el.setAttribute('data-theme', pref)
}

/**
 * The theme in effect (light or dark), resolving 'system' against the OS.
 * For callers that need concrete colors rather than CSS variables, such as
 * the xterm canvas. Defaults to dark when the OS preference can't be read.
 */
export function resolveEffectiveTheme(): 'light' | 'dark' {
  const attr = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null
  if (attr === 'light' || attr === 'dark') return attr
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'dark'
}
