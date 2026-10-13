import { useRef, type HTMLAttributes, type TouchEvent } from 'react'

export type TouchHandlers = Pick<HTMLAttributes<HTMLElement>, 'onTouchStart' | 'onTouchMove' | 'onTouchEnd' | 'onTouchCancel'>

/** How far apart the first two fingers are, or 0 unless exactly two touch. */
function spread(e: TouchEvent): number {
  if (e.touches.length !== 2) return 0
  const [a, b] = [e.touches[0], e.touches[1]]
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

/**
 * Touch handlers that turn a two-finger pinch into a text size: the size the
 * pinch started at, scaled by how far the fingers have spread since. `setSize`
 * clamps and rounds.
 *
 * The element they go on must set `touch-action: pan-x pan-y`, which keeps
 * one-finger scrolling native but stops the browser zooming the page on a
 * pinch, so these handlers can stay passive.
 */
export function usePinchSize(size: number, setSize: (px: number) => void): TouchHandlers {
  const start = useRef<{ spread: number; size: number } | null>(null)
  const begin = (e: TouchEvent): void => {
    const s = spread(e)
    start.current = s > 0 ? { spread: s, size } : null
  }
  return {
    onTouchStart: begin,
    onTouchEnd: begin,
    onTouchCancel: begin,
    onTouchMove: (e) => {
      const s = spread(e)
      if (start.current && s > 0) setSize(start.current.size * s / start.current.spread)
    },
  }
}
