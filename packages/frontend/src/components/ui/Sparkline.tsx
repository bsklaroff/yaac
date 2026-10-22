import { useState, type JSX, type KeyboardEvent, type PointerEvent } from 'react'

const WIDTH = 96
const HEIGHT = 24
/** Room for the end dot's radius and ring, so it is never clipped. */
const PAD = 4

/**
 * A single-series trend line: a 2px line over a faint wash, with a dot on
 * the newest point. Hovering (or arrow keys, once focused) moves a hairline
 * to the nearest point and shows its value and time. Every value it plots
 * is a summary the caller also shows as text, so the tooltip only adds the
 * history.
 */
export function Sparkline({ points, format, label, max }: {
  points: Array<{ at: number; value: number }>
  format: (value: number) => string
  /** What it plots, for screen readers. */
  label: string
  /** The top of the scale; defaults to the largest value. */
  max?: number
}): JSX.Element {
  const [active, setActive] = useState<number | null>(null)
  if (points.length < 2) {
    return <span className="inline-block text-[10px] text-text-faint" style={{ width: WIDTH }}>collecting…</span>
  }
  const top = Math.max(max ?? 0, ...points.map((p) => p.value)) || 1
  const first = points[0].at
  const span = (points[points.length - 1].at - first) || 1
  const x = (at: number): number => PAD + ((at - first) / span) * (WIDTH - 2 * PAD)
  const y = (value: number): number => HEIGHT - PAD - (value / top) * (HEIGHT - 2 * PAD)
  const line = points.map((p) => `${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  const area = `${x(first).toFixed(1)},${String(HEIGHT - PAD)} ${line} ${x(first + span).toFixed(1)},${String(HEIGHT - PAD)}`
  const end = points[points.length - 1]
  const shown = active === null ? null : points[active]

  const pick = (e: PointerEvent<SVGSVGElement>): void => {
    const box = e.currentTarget.getBoundingClientRect()
    const at = first + ((e.clientX - box.left - PAD) / (box.width - 2 * PAD)) * span
    let best = 0
    for (const [i, p] of points.entries()) {
      if (Math.abs(p.at - at) < Math.abs(points[best].at - at)) best = i
    }
    setActive(best)
  }
  const step = (e: KeyboardEvent<SVGSVGElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const from = active ?? points.length - 1
    setActive(Math.max(0, Math.min(points.length - 1, from + (e.key === 'ArrowLeft' ? -1 : 1))))
  }

  return (
    <span className="relative inline-block align-middle">
      <svg
        width={WIDTH}
        height={HEIGHT}
        role="img"
        aria-label={`${label}, last hour: now ${format(end.value)}`}
        tabIndex={0}
        className="block cursor-crosshair overflow-visible rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-link"
        onPointerMove={pick}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive(points.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={step}
      >
        <polygon points={area} className="fill-link/10" />
        <polyline
          points={line}
          fill="none"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          className="stroke-link"
        />
        {shown && (
          <line
            x1={x(shown.at)}
            x2={x(shown.at)}
            y1={0}
            y2={HEIGHT}
            strokeWidth={1}
            className="stroke-text-faint"
          />
        )}
        <circle
          cx={x((shown ?? end).at)}
          cy={y((shown ?? end).value)}
          r={4}
          strokeWidth={2}
          className="fill-link stroke-surface"
        />
      </svg>
      {shown && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap
            rounded border border-hairline bg-surface-2 px-1.5 py-0.5 text-[10px] shadow"
        >
          <span className="font-semibold tabular-nums text-text">{format(shown.value)}</span>
          <span className="ml-1 text-text-dim">
            {new Date(shown.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </span>
      )}
    </span>
  )
}
