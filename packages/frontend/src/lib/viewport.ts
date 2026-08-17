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
 * Publish the *visual* viewport — its height as `--app-height` and its offset
 * from the layout viewport as `--app-top` — which index.css gives to `#root`.
 *
 * The layout viewport does not shrink when a soft keyboard opens (iOS Safari
 * in particular just slides the page), so a `100dvh` app puts the bottom of
 * the terminal behind the keyboard. `window.visualViewport` is the only thing
 * that reports the keyboard reliably across iOS and Android; feeding its
 * height into the root makes the whole layout — and therefore WorktreeView's
 * ResizeObserver, and therefore the PTY's row count — track the space the user
 * can actually see.
 *
 * Sizing alone is not enough, because a keyboard does not only shrink the
 * visual viewport: it *slides* it. Focusing the chat composer makes iOS scroll
 * the control into view before the resize lands, and it never scrolls back, so
 * an app sized to the visible space still sits at the top of the layout
 * viewport — squeezed above the space it was measured for, with the page's
 * background showing below it and a finger free to drag the shell around in
 * the gap. The offset is what closes that gap: `#root` is `position: fixed`,
 * so moving it down by exactly the slide puts the app back over the region the
 * user can see, and there is nothing below it left to scroll to.
 *
 * A pinch-zoom pans the visual viewport too, and that pan is the user's own —
 * re-anchoring the app to the top of it on every frame would make a zoomed
 * page impossible to look around. `scale` is what tells the two apart: a
 * keyboard leaves it at 1, zooming does not.
 *
 * With a tolerance, because the two failures are not symmetric. `scale` is a
 * float a browser is free to leave a hair off 1 after a pinch, and a strict
 * comparison that stays true forever turns the keyboard compensation off for
 * good on that device — the bug back, silently, with no zoom on screen to
 * suggest why. Below a percent there is no pan worth preserving anyway, so the
 * threshold costs nothing and removes the cliff.
 *
 * Only enabled on mobile: on a desktop the visual viewport also shrinks under
 * pinch-zoom, where reflowing the app is not what anyone wants.
 */
/** Past this, the visual viewport's pan is a pinch-zoom's rather than a
 *  keyboard's — see useVisualViewportHeight. */
const ZOOMED_SCALE = 1.01

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
    // The keyboard opening also *scrolls* the visual viewport on iOS without
    // always firing resize; recomputing on both keeps the two in step.
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      clear()
    }
  }, [enabled])
}
