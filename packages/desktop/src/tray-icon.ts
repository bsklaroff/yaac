/**
 * Build the tray glyph in-code (no binary asset — keeps the whole shell
 * editable/testable from a headless yaac workspace). Returns a raw BGRA bitmap
 * of a black yak-head silhouette (horns, ears, head), after the app icon:
 * RGB=0, alpha=coverage, transparent outside. Template images ignore RGB and
 * use the alpha channel, so main.ts recolors it to match the menu bar. Pure
 * (no Electron) so it's unit-testable.
 */
export function buildTrayBitmap(size: number): { data: Buffer; width: number; height: number } {
  const data = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Antialias by sampling a SAMPLES x SAMPLES grid inside each pixel.
      let hits = 0
      for (let j = 0; j < SAMPLES; j++) {
        for (let i = 0; i < SAMPLES; i++) {
          if (inYak((x + (i + 0.5) / SAMPLES) / size, (y + (j + 0.5) / SAMPLES) / size)) hits++
        }
      }
      // BGRA, black shape: B=G=R=0; only alpha carries the coverage.
      data[(y * size + x) * 4 + 3] = Math.round((hits / SAMPLES ** 2) * 255)
    }
  }
  return { data, width: size, height: size }
}

const SAMPLES = 4

/** Whether a point in unit coordinates (0..1, y down) is on the yak. */
function inYak(x: number, y: number): boolean {
  // The glyph is symmetric, so everything is drawn on the left half.
  const lx = Math.min(x, 1 - x)
  const head = Math.abs((x - 0.5) / 0.28) ** 2.4 + Math.abs((y - 0.58) / 0.36) ** 2.4 <= 1
  const ear = ((lx - 0.19) / 0.12) ** 2 + ((y - 0.46) / 0.06) ** 2 <= 1
  // One disc minus an offset one leaves a crescent: a tapered, pointed horn.
  const horn = lx < 0.36 && inCircle(lx, y, 0.33, 0.17, 0.2) && !inCircle(lx, y, 0.37, 0.1, 0.2)
  return head || ear || horn
}

function inCircle(x: number, y: number, cx: number, cy: number, r: number): boolean {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}
