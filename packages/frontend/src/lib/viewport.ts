import { useEffect, useSyncExternalStore } from 'react'

/**
 * The app's one mobile breakpoint (docs/mobile-layout.md). Below it the app
 * is a three-screen mobile shell (projects → workspaces → pane); above it,
 * the desktop layout. It checks width only, not `pointer: coarse`, so a
 * narrow desktop window (or a Playwright script) gets the mobile shell.
 *
 * 767px is Tailwind's `md` boundary, so `max-md:` utilities match it. Keep
 * them in step.
 */
export const MOBILE_QUERY = '(max-width: 767px)'

function query(): MediaQueryList | null {
  if (typeof window === 'undefined' || !window.matchMedia) return null
  return window.matchMedia(MOBILE_QUERY)
}

/** One-time read, for tests and non-React callers. */
export function isMobileViewport(): boolean {
  return query()?.matches ?? false
}

function subscribe(onChange: () => void): () => void {
  const mq = query()
  if (!mq) return () => { /* no matchMedia — the snapshot never changes */ }
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

/** Whether the viewport is phone-sized, tracked live across resize/rotation. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, isMobileViewport, () => false)
}

/** Above this scale, the visual viewport is pinch-zoomed. A browser may leave
 *  `scale` slightly off 1 after a pinch, so an exact check would disable the
 *  keyboard offset for good. */
const ZOOMED_SCALE = 1.01

/**
 * Publish the visual viewport's height as `--app-height` and its offset from
 * the layout viewport as `--app-top`, which index.css applies to `#root`.
 *
 * A soft keyboard doesn't shrink the layout viewport (iOS just slides the
 * page), so a `100dvh` app would hide the terminal's bottom behind it. Using
 * `visualViewport`'s height makes the layout, and so the PTY's row count,
 * fit the visible space. iOS also scrolls the viewport to show a focused
 * input and never scrolls back; `#root` is `position: fixed`, so offsetting
 * it by that scroll keeps the app over the visible region.
 *
 * A pinch-zoom also pans the viewport, and following that pan would make a
 * zoomed page impossible to look around, so the offset is skipped while
 * zoomed. Only enabled on mobile, since desktop pinch-zoom shouldn't reflow
 * the app.
 */
export function useVisualViewportHeight(enabled: boolean): void {
  useEffect(() => {
    const root = typeof document !== 'undefined' ? document.documentElement : null
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!root) return
    const clear = (): void => {
      root.style.removeProperty('--app-height')
      root.style.removeProperty('--app-top')
    }
    if (!enabled || !vv) {
      clear()
      return
    }
    const apply = (): void => {
      root.style.setProperty('--app-height', `${vv.height}px`)
      root.style.setProperty('--app-top', `${vv.scale > ZOOMED_SCALE ? 0 : vv.offsetTop}px`)
    }
    apply()
    vv.addEventListener('resize', apply)
    // On iOS the keyboard can scroll the viewport without firing resize.
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      clear()
    }
  }, [enabled])
}
