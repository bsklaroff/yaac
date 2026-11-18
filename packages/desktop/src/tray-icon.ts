/**
 * Build the tray glyph in-code (no binary asset — keeps the whole shell
 * editable/testable from a headless yaac workspace). Returns a raw BGRA bitmap
 * of the yaac logo's four strokes (packages/frontend/src/logo.svg),
 * transparent outside. In black it serves as a macOS template image, which
 * ignores RGB and uses the alpha channel, so the menu bar recolors it.
 * Windows uses the color as drawn, so main.ts picks white for a dark
 * taskbar. Pure (no Electron) so it's unit-testable.
 */
export function buildTrayBitmap(size: number, color: 'black' | 'white' = 'black'): Bitmap {
  const v = color === 'white' ? 255 : 0
  const rgb: Rgb = [v, v, v]
  return rasterize(size, (u, v) => inMark(u, v) ? rgb : null)
}

/**
 * The app icon's look in miniature, an orange mark on a near-black rounded
 * tile, for Linux trays. Their panels may be light or dark whatever the
 * app's theme says (GNOME's is dark in its light style too), and they
 * recolor only symbolic icons, so the icon has to read on either.
 */
export function buildTileBitmap(size: number): Bitmap {
  return rasterize(size, (u, v) => {
    if (!inRoundedSquare(u, v, TILE_RADIUS)) return null
    return inMark((u - 0.5) / TILE_MARK_SCALE + 0.5, (v - 0.5) / TILE_MARK_SCALE + 0.5) ? ICON_ORANGE : ICON_TILE
  })
}

/**
 * A red dot, which Windows lays over the taskbar button while a workspace
 * waits (its stand-in for a dock badge).
 */
export function buildBadgeBitmap(size: number): Bitmap {
  const red: Rgb = [0xe5, 0x48, 0x4d]
  return rasterize(size, (u, v) => Math.hypot(u - 0.5, v - 0.5) <= 0.45 ? red : null)
}

type Bitmap = { data: Buffer; width: number; height: number }
type Rgb = [number, number, number]

/** build/icon.png's tile and stroke colors. */
const ICON_TILE: Rgb = [0x17, 0x17, 0x1a]
const ICON_ORANGE: Rgb = [0xf2, 0x98, 0x52]
const TILE_RADIUS = 0.22
const TILE_MARK_SCALE = 0.72

function inRoundedSquare(u: number, v: number, r: number): boolean {
  const dx = Math.max(r - u, u - (1 - r), 0)
  const dy = Math.max(r - v, v - (1 - r), 0)
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 && Math.hypot(dx, dy) <= r
}

/**
 * A BGRA bitmap of what `paint` gives at each point (transparent where it
 * gives null), antialiased by averaging a grid of samples per pixel.
 */
function rasterize(size: number, paint: (u: number, v: number) => Rgb | null): Bitmap {
  const data = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0
      const sum = [0, 0, 0]
      for (let j = 0; j < SAMPLES; j++) {
        for (let i = 0; i < SAMPLES; i++) {
          const rgb = paint((x + (i + 0.5) / SAMPLES) / size, (y + (j + 0.5) / SAMPLES) / size)
          if (!rgb) continue
          hits++
          for (let c = 0; c < 3; c++) sum[c] += rgb[c]
        }
      }
      const at = (y * size + x) * 4
      if (hits > 0) data.set([sum[2], sum[1], sum[0]].map((c) => Math.round(c / hits)), at)
      data[at + 3] = Math.round((hits / SAMPLES ** 2) * 255)
    }
  }
  return { data, width: size, height: size }
}

const SAMPLES = 4

/**
 * The left half of logo.svg, in its 540-unit grid: each stroke is a run of
 * line and arc pieces with butt ends, `HALF_WIDTH` either side of the line.
 * The right half mirrors it about x = 269.5. A glyph `SPAN` units across,
 * centered on the strokes, fills the tray icon. The geometry matches the
 * yaac-site favicon: strokes thinner than the logo's 43.75, and each stroke
 * moved `shift` units outward, so every gap between stems keeps two clear
 * pixels at 36px. At the logo's proportions the four stems blur into one
 * block.
 */
type Piece = { line: [number, number, number, number] } | { arc: [number, number, number, number, number, number, number] }
const STROKES: { shift: number; pieces: Piece[] }[] = [
  {
    shift: 10,
    pieces: [
      { line: [113.4, 73, 113.4, 96.25] },
      { arc: [196.24, 96.25, 82.84, 113.4, 96.25, 148.12, 163.68] },
      { line: [148.12, 163.68, 211.22, 208.71] },
      { arc: [170.47, 265.82, 70.16, 211.22, 208.71, 240.63, 265.82] },
      { line: [240.63, 265.82, 240.63, 491.5] },
    ],
  },
  {
    shift: 24,
    pieces: [
      { line: [115.75, 245.875, 144.16, 245.875] },
      { arc: [144.16, 284.35, 38.47, 144.16, 245.875, 182.625, 284.35] },
      { line: [182.625, 284.35, 182.625, 437.5] },
    ],
  },
]
const HALF_WIDTH = 19.5
const MIRROR_X = 269.5
const CENTER_Y = 282.25
const SPAN = 440

/** Whether a point in unit coordinates (0..1, y down) is on the mark. */
function inMark(u: number, v: number): boolean {
  const x = MIRROR_X - Math.abs((u - 0.5) * SPAN)
  const y = CENTER_Y + (v - 0.5) * SPAN
  return STROKES.some(({ shift, pieces }) => pieces.some((p) =>
    'line' in p ? onLine(x + shift, y, ...p.line) : onArc(x + shift, y, ...p.arc)))
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
