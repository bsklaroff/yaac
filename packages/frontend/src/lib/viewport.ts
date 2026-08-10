import { useEffect, useSyncExternalStore } from 'react'

/**
 * Viewport shape — one breakpoint for the whole app.
 *
 * Below it the webapp is a three-screen mobile shell (projects → worktrees →
 * pane); above it the desktop rail + sidebar + pane row. Width-only, not
 * `pointer: coarse`, so a narrow desktop window gets the mobile shell too —
 * which is what makes it drivable from a Playwright script.
 *
 * 767px is Tailwind's `md` boundary, so `max-md:` utilities in the components
 * mean exactly the same thing this constant does. Keep them in step.
 */
export const MOBILE_QUERY = '(max-width: 767px)'

function query(): MediaQueryList | null {
  if (typeof window === 'undefined' || !window.matchMedia) return null
  return window.matchMedia(MOBILE_QUERY)
}

/** One-shot read (exported for tests and non-React callers). */
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

/**
 * Publish the *visual* viewport height as `--app-height`, which index.css
 * gives to `#root`.
 *
 * The layout viewport does not shrink when a soft keyboard opens (iOS Safari
 * in particular just slides the page), so a `100dvh` app puts the bottom of
 * the terminal behind the keyboard. `window.visualViewport` is the only thing
 * that reports the keyboard reliably across iOS and Android; feeding its
 * height into the root makes the whole layout — and therefore WorktreeView's
 * ResizeObserver, and therefore the PTY's row count — track the space the user
 * can actually see.
 *
 * Only enabled on mobile: on a desktop the visual viewport also shrinks under
 * pinch-zoom, where reflowing the app is not what anyone wants.
 */
export function useVisualViewportHeight(enabled: boolean): void {
  useEffect(() => {
    const root = typeof document !== 'undefined' ? document.documentElement : null
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!root) return
    if (!enabled || !vv) {
      root.style.removeProperty('--app-height')
      return
    }
    const apply = (): void => { root.style.setProperty('--app-height', `${vv.height}px`) }
    apply()
    vv.addEventListener('resize', apply)
    // The keyboard opening also *scrolls* the visual viewport on iOS without
    // always firing resize; recomputing on both keeps the two in step.
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      root.style.removeProperty('--app-height')
    }
  }, [enabled])
}
