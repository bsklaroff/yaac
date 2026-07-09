/**
 * The native BrowserWindow background — the color painted behind the web
 * content (visible for a frame at the edges during a live resize, and under
 * the window's rounded corners). Matched to the OS appearance so a light-mode
 * window doesn't flash the dark shell on resize (and vice versa).
 *
 * These mirror --color-bg for each theme in src/frontend/index.css. Note this
 * follows the OS only: a manual light/dark override chosen in the renderer
 * recolors the content (via CSS) but not this native backing, since the main
 * process isn't told about it. The common "System" case stays correct.
 */
export function backgroundColorFor(dark: boolean): string {
  return dark ? '#0b0b0d' : '#efeee9'
}
