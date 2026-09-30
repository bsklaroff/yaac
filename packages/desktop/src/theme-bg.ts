/**
 * The native BrowserWindow background, visible at the edges during a resize
 * and under the rounded corners. The values mirror --color-shell in the
 * frontend's index.css. It follows the OS appearance only: the main process
 * is not told about a light/dark override chosen in the renderer.
 */
export function backgroundColorFor(dark: boolean): string {
  return dark ? '#0f0f12' : '#fcfcfb'
}
