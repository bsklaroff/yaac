import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Whether the window would be at least partly visible on one of the displays,
 * so a saved position from a since-disconnected monitor doesn't strand the
 * window off-screen — the caller falls back to default (centered) bounds.
 */
export function boundsVisibleOn(bounds: Rect, displays: Rect[]): boolean {
  return displays.some((d) =>
    bounds.x < d.x + d.width && bounds.x + bounds.width > d.x
    && bounds.y < d.y + d.height && bounds.y + bounds.height > d.y)
}

/** Read persisted window bounds; null when absent or malformed. */
export async function readWindowState(file: string): Promise<Rect | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    const values = ['x', 'y', 'width', 'height'].map((k) => parsed[k])
    if (values.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      const [x, y, width, height] = values as number[]
      return { x, y, width, height }
    }
  } catch {
    // no state yet or unreadable
  }
  return null
}

/** Persist window bounds (best-effort — a failed save just means defaults next launch). */
export async function saveWindowState(file: string, bounds: Rect): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(bounds))
  } catch {
    // ignore
  }
}
