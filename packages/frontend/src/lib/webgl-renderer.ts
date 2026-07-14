import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'

/**
 * Swap xterm's DOM renderer for the WebGL one. The DOM renderer positions
 * each row on the CSS-pixel grid independently of the device-pixel grid, so
 * at fractional devicePixelRatios (browser zoom, hidpi scaling) the per-row
 * rounding intermittently leaves a hairline of page background between
 * adjacent rows — visible as blank seams slicing through solid-colored
 * output. The WebGL renderer rasterizes cells on the device-pixel grid, so
 * rows always tile exactly.
 *
 * Call after `term.open()`. Returns false when WebGL2 is unavailable (the
 * addon throws during activation), leaving the DOM renderer in place. On a
 * later context loss (GPU reset, driver eviction) the addon is disposed,
 * which makes xterm itself fall back to the DOM renderer.
 */
export function enableWebglRenderer(term: Terminal): boolean {
  const addon = new WebglAddon()
  addon.onContextLoss(() => addon.dispose())
  try {
    term.loadAddon(addon)
  } catch {
    // loadAddon registers the addon before activating it, so unregister the
    // half-loaded instance rather than leaving it for term.dispose().
    addon.dispose()
    return false
  }
  return true
}
