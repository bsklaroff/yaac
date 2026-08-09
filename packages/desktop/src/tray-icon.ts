/**
 * Build the tray glyph in-code (no binary asset — keeps the whole shell
 * editable/testable from a headless yaac worktree). Returns a raw BGRA bitmap
 * of a black, antialiased rounded square: RGB=0, alpha=coverage, transparent
 * outside. Template images ignore RGB and use the alpha channel, so main.ts
 * recolors it to match the menu bar. Pure (no Electron) so it's unit-testable.
 */
export function buildTrayBitmap(size: number): { data: Buffer; width: number; height: number } {
  const data = Buffer.alloc(size * size * 4)
  const margin = size * 0.14
  const x0 = margin
  const y0 = margin
  const x1 = size - margin
  const y1 = size - margin
  const radius = size * 0.24
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cov = roundedRectCoverage(x + 0.5, y + 0.5, x0, y0, x1, y1, radius)
      // BGRA, black shape: B=G=R=0; only alpha carries the coverage.
      data[(y * size + x) * 4 + 3] = Math.round(cov * 255)
    }
  }
  return { data, width: size, height: size }
}

/**
 * Antialiased coverage (0..1) of a rounded rect at pixel-center (px,py), via
 * the standard rounded-box signed distance: negative inside, 0 on the edge.
 * A ~1px linear ramp across the boundary gives smooth edges.
 */
function roundedRectCoverage(
  px: number, py: number,
  x0: number, y0: number, x1: number, y1: number,
  r: number,
): number {
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const halfW = (x1 - x0) / 2
  const halfH = (y1 - y0) / 2
  const qx = Math.abs(px - cx) - (halfW - r)
  const qy = Math.abs(py - cy) - (halfH - r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inside = Math.min(Math.max(qx, qy), 0)
  const dist = outside + inside - r
  return Math.min(Math.max(0.5 - dist, 0), 1)
}
