import { useMemo, type CSSProperties, type JSX } from 'react'
import type { IdentityFamily } from './identity'

/*
 * The moving lanes on a working project's tile: vertical lanes of blocks
 * drifting down, seeded from the project so each project has its own lane
 * width and block length, with each lane at its own speed and phase, all
 * faster with more agents (`rate` 1 to 3). Each lane is a strip one tile
 * taller than its blocks' repeat, painted with hard-stop gradients and
 * slid down one repeat at a time (`animate-lane-fall`), so it loops
 * seamlessly on the compositor. The colours are the family's theme tokens,
 * so they follow the theme by themselves. They keep moving under the OS's
 * reduced-motion setting: the motion is how the rail says a project is
 * working, not decoration.
 */

/* A repeatable pseudo-random number in 0…1. */
const hs = (n: number): number => {
  const x = Math.sin(n * 91.345) * 47453.5453
  return x - Math.floor(x)
}

/* `p` percent of `b` over `a`. */
const mix = (a: string, b: string, p: number): string => `color-mix(in srgb, ${b} ${p}%, ${a})`

export function YLanes({ family, seedKey, size, rate = 1, bright = false }: {
  family: IdentityFamily
  /** What the lanes are seeded from: the project's id. */
  seedKey: string
  size: number
  rate?: number
  /** The lit tile's lanes, drawn in the family's fill shades. */
  bright?: boolean
}): JSX.Element {
  const [c0, c1, c2] = (bright ? ['glow', 'fill', 'ink'] : ['deep', 'tint', 'glow']).map((s) => `var(--proj-${family}-${s})`)
  const lanes = useMemo(() => {
    const seed = [...seedKey].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 997, 7) / 97.3
    const pitch = (0.1 + 0.05 * hs(seed * 5.1)) * size
    const block = (0.22 + 0.2 * hs(seed * 2.2)) * size
    // Tile heights a second, before each lane's own factor.
    const speed = (0.05 + 0.04 * hs(seed * 4.4)) * Math.min(3, Math.max(1, rate))
    // Enough blocks that a repeat is taller than the tile.
    const blocks = Math.ceil(size / block) + 2
    const repeat = blocks * block
    return Array.from({ length: Math.ceil(size / pitch) }, (_, i) => {
      const tones = Array.from({ length: blocks }, (_, j) => {
        const k = hs(i * 13.7 + j * 3.1 + seed * 31)
        return k < 0.45 ? 'c1' : k < 0.7 ? 'lo' : k < 0.9 ? 'mid' : 'hi'
      })
      const duration = repeat / (speed * (0.5 + hs(i + seed * 7)) * size)
      return { left: i * pitch, pitch, block, repeat, tones, duration, delay: -hs(i + seed) * duration }
    })
  }, [seedKey, size, rate])
  const tone: Record<string, string> = { c1, lo: mix(c0, c1, 70), mid: mix(c1, c2, 13), hi: mix(c1, c2, 25) }
  return (
    <span aria-hidden className="absolute inset-0 overflow-hidden" style={{ background: mix(c0, c1, 55) }}>
      {lanes.map((l, i) => (
        <span
          key={i}
          className="absolute top-0 animate-lane-fall"
          style={{
            // A thin gap of the background colour on each lane's left.
            left: l.left + 0.13 * l.pitch,
            width: 0.87 * l.pitch,
            height: l.repeat + size,
            backgroundImage: `linear-gradient(${l.tones.map((t, j) => `${tone[t]} ${j * l.block}px ${(j + 1) * l.block}px`).join(', ')})`,
            backgroundSize: `100% ${l.repeat}px`,
            animationDuration: `${l.duration}s`,
            animationDelay: `${l.delay}s`,
            '--lane-repeat': `${l.repeat}px`,
          } as CSSProperties}
        />
      ))}
    </span>
  )
}
