/**
 * Build the tray glyph in-code (no binary asset — keeps the whole shell
 * editable/testable from a headless yaac workspace). Returns a raw BGRA bitmap
 * of the yaac logo's four strokes (packages/frontend/src/logo.svg) in black:
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
          if (inMark((x + (i + 0.5) / SAMPLES) / size, (y + (j + 0.5) / SAMPLES) / size)) hits++
        }
      }
      // BGRA, black shape: B=G=R=0; only alpha carries the coverage.
      data[(y * size + x) * 4 + 3] = Math.round((hits / SAMPLES ** 2) * 255)
    }
  }
  return { data, width: size, height: size }
}

const SAMPLES = 4

/**
 * The left half of logo.svg, in its 540-unit grid: each stroke is a run of
 * line and arc pieces with butt ends, `HALF_WIDTH` either side of the line.
 * The right half mirrors it about x = 269.5. A glyph `SPAN` units across,
 * centered on the strokes, fills the tray icon. The strokes are thinner than
 * the logo's 43.75 so each gap between them keeps a clear pixel at 36px;
 * at full width the four stems blur into one block.
 */
type Piece = { line: [number, number, number, number] } | { arc: [number, number, number, number, number, number, number] }
const STROKES: Piece[] = [
  { line: [113.4, 73, 113.4, 96.25] },
  { arc: [196.24, 96.25, 82.84, 113.4, 96.25, 148.12, 163.68] },
  { line: [148.12, 163.68, 211.22, 208.71] },
  { arc: [170.47, 265.82, 70.16, 211.22, 208.71, 240.63, 265.82] },
  { line: [240.63, 265.82, 240.63, 491.5] },
  { line: [115.75, 245.875, 144.16, 245.875] },
  { arc: [144.16, 284.35, 38.47, 144.16, 245.875, 182.625, 284.35] },
  { line: [182.625, 284.35, 182.625, 437.5] },
]
const HALF_WIDTH = 16
const MIRROR_X = 269.5
const CENTER_Y = 282.25
const SPAN = 440

/** Whether a point in unit coordinates (0..1, y down) is on the mark. */
function inMark(u: number, v: number): boolean {
  const x = MIRROR_X - Math.abs((u - 0.5) * SPAN)
  const y = CENTER_Y + (v - 0.5) * SPAN
  return STROKES.some((p) => ('line' in p ? onLine(x, y, ...p.line) : onArc(x, y, ...p.arc)))
}

function onLine(x: number, y: number, x1: number, y1: number, x2: number, y2: number): boolean {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy)
  const along = ((x - x1) * dx + (y - y1) * dy) / len
  const across = ((x - x1) * dy - (y - y1) * dx) / len
  return along >= 0 && along <= len && Math.abs(across) <= HALF_WIDTH
}

/** An arc of under 180°, from (x1, y1) to (x2, y2) around (cx, cy). */
function onArc(x: number, y: number, cx: number, cy: number, r: number, x1: number, y1: number, x2: number, y2: number): boolean {
  const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx
  const [px, py, sx, sy, ex, ey] = [x - cx, y - cy, x1 - cx, y1 - cy, x2 - cx, y2 - cy]
  const turn = Math.sign(cross(sx, sy, ex, ey))
  return Math.sign(cross(sx, sy, px, py)) !== -turn && Math.sign(cross(px, py, ex, ey)) !== -turn
    && Math.abs(Math.hypot(px, py) - r) <= HALF_WIDTH
}
