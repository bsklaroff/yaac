import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

/** How far the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 5

export interface PressDrag<T, O> {
  /** The dragged item, and the drop target under the pointer (undefined
   *  for none). */
  item: T
  over: O | undefined
}

/**
 * Something that is both a click target and a drag handle (a sidebar row, a
 * pane's tab). A press stays a click until the pointer travels
 * DRAG_THRESHOLD px; then it is a drag, and `over` names the drop target
 * under the pointer on each move. Releasing calls `onClick` for a click and
 * `onDrop` for a drag; a cancelled pointer, or the component unmounting,
 * abandons the press.
 *
 * `start` is the item's pointerdown handler. It prevents the default, so the
 * browser's own click never fires and `onClick` stands in for it.
 */
export function usePressDrag<T, O>(opts: {
  over: (x: number, y: number) => O | undefined
  onDrop: (drag: PressDrag<T, O>) => void
}): {
  /** The drag in progress; null while idle or still a click. */
  drag: PressDrag<T, O> | null
  start: (e: ReactPointerEvent, item: T, onClick: () => void) => void
} {
  const [drag, setDrag] = useState<PressDrag<T, O> | null>(null)
  const latest = useRef(opts)
  latest.current = opts
  const abandon = useRef<(() => void) | null>(null)
  useEffect(() => () => abandon.current?.(), [])

  const start = (e: ReactPointerEvent, item: T, onClick: () => void): void => {
    e.preventDefault()
    abandon.current?.()
    const x0 = e.clientX
    const y0 = e.clientY
    let current: PressDrag<T, O> | null = null
    const onMove = (ev: PointerEvent): void => {
      if (!current && Math.hypot(ev.clientX - x0, ev.clientY - y0) <= DRAG_THRESHOLD) return
      current = { item, over: latest.current.over(ev.clientX, ev.clientY) }
      setDrag(current)
    }
    const end = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', end)
      abandon.current = null
      setDrag(null)
    }
    const onUp = (): void => {
      end()
      if (current) latest.current.onDrop(current)
      else onClick()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', end)
    abandon.current = end
  }

  return { drag, start }
}
