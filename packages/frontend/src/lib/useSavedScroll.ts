import { useLayoutEffect, useRef, type UIEvent } from 'react'
import { useUiStore } from './store'

/** How long a restore waits for the content to grow again before it gives
 *  up on a position the content no longer reaches. */
const SETTLE_MS = 2000

/**
 * Keep a scrolling element's position in its pane's `paneView` entry, which
 * outlives the pane's mount and is saved across reloads (a server switch
 * reloads the page). When `el` mounts, the saved position is put back, and
 * put back again as its content grows (rows and diffs arrive after the first
 * render, images load). The restore ends when `el` reaches the position, when
 * anything else scrolls it (the user, find), or once the content has stopped
 * growing for SETTLE_MS. Returns the `onScroll` handler that records new
 * positions; until the restore ends it ignores the restore's own scrolls,
 * which would save the short content's clamped position.
 */
export function useSavedScroll(viewKey: string, el: HTMLElement | null): (e: UIEvent<HTMLElement>) => void {
  /** The restore under way: where it last left `el`, and how to end it. */
  const restore = useRef<{ at: number; stop: () => void } | null>(null)
  useLayoutEffect(() => {
    const want = useUiStore.getState().paneView[viewKey]?.scroll ?? 0
    if (!el || want <= 0) return
    const node: HTMLElement = el
    const current = { at: -1, stop }
    restore.current = current
    let height = 0
    let settle: ReturnType<typeof setTimeout> | undefined
    function apply(): void {
      if (current.at >= 0 && Math.abs(node.scrollTop - current.at) > 1) return stop()
      node.scrollTop = want
      current.at = node.scrollTop
      if (current.at >= want - 1) return stop()
      if (node.scrollHeight > height) {
        height = node.scrollHeight
        clearTimeout(settle)
        settle = setTimeout(stop, SETTLE_MS)
      }
    }
    function stop(): void {
      if (restore.current === current) restore.current = null
      growth.disconnect()
      clearTimeout(settle)
      node.removeEventListener('load', apply, true)
    }
    const growth = new MutationObserver(apply)
    growth.observe(node, { childList: true, subtree: true })
    node.addEventListener('load', apply, true)
    apply()
    return stop
  }, [viewKey, el])
  return (e) => {
    const top = e.currentTarget.scrollTop
    if (restore.current && Math.abs(top - restore.current.at) <= 1) return
    restore.current?.stop()
    useUiStore.getState().setPaneView(viewKey, { scroll: top })
  }
}
