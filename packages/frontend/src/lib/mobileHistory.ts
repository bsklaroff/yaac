import { useEffect } from 'react'
import { useUiStore, type MobileScreen } from '#lib/store'

/**
 * What the mobile shell stores on a history entry, alongside whatever else
 * is there (persistSelection's replaceState keeps the other fields).
 *
 * `yaacDepth` counts the entries this shell pushed to get here. Storing it
 * on the entry means a `popstate` in either direction lands on an entry that
 * already knows its depth.
 */
interface ScreenState { yaacScreen?: MobileScreen; yaacDepth?: number }

/** The screen a back gesture from each screen lands on. */
const PARENT: Record<MobileScreen, MobileScreen> = {
  projects: 'projects',
  workspaces: 'projects',
  pane: 'workspaces',
}

function stampOf(state: unknown): ScreenState {
  return (state ?? {})
}

/** How many of our entries are below the current one. Zero (or no stamp)
 *  means this is the entry the app loaded on, and `back()` would leave it. */
function depthOf(state: unknown): number {
  return stampOf(state).yaacDepth ?? 0
}

// Set while stepping back by hand, so the sync effect replaces the current
// entry instead of pushing one. The effect clears it on every run.
let steppingBack = false

/** Reset module state (also used by tests). */
export function resetMobileHistory(): void {
  steppingBack = false
}

/**
 * Go back a screen. The header chevrons call this, so they behave like the
 * Android back button and the iOS edge swipe.
 *
 * At depth 0 (e.g. a load that restored `pane` from localStorage), `back()`
 * would leave the app, so this sets the parent screen directly and the
 * current entry is replaced rather than pushed.
 */
export function goBackScreen(): void {
  if (typeof window === 'undefined') return
  if (depthOf(window.history.state) > 0) {
    window.history.back()
    return
  }
  const state = useUiStore.getState()
  const parent = PARENT[state.mobileScreen]
  // At the root there is no parent. Setting the same screen would not run
  // the effect, leaving `steppingBack` set.
  if (parent === state.mobileScreen) return
  steppingBack = true
  state.setMobileScreen(parent)
}

/**
 * Mirror the mobile screen into the browser history.
 *
 * Moving to a screen pushes an entry; a `popstate` reads the screen from the
 * entry it lands on. After a pop, the entry and the store agree, so the sync
 * effect returns early without needing a "from popstate" flag.
 *
 * A jump straight to the pane (e.g. `openWorkspace` from a notification)
 * pushes one entry, so back returns to the screen the user was on.
 */
export function useMobileHistory(enabled: boolean): void {
  const screen = useUiStore((s) => s.mobileScreen)

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const onPop = (e: PopStateEvent): void => {
      useUiStore.getState().setMobileScreen(stampOf(e.state).yaacScreen ?? 'projects')
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      resetMobileHistory()
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const stepping = steppingBack
    steppingBack = false
    const stamp = stampOf(window.history.state)
    // Already on this screen's entry (after a pop, or a matching reload).
    if (stamp.yaacScreen === screen) return
    const url = window.location.pathname + window.location.search + window.location.hash
    const base = { ...(window.history.state as object | null), yaacScreen: screen }
    // Replace on the first sync (pushing would leave an unstamped entry
    // below) and on a manual step back.
    if (stamp.yaacScreen === undefined || stepping) {
      window.history.replaceState({ ...base, yaacDepth: stamp.yaacDepth ?? 0 }, '', url)
      return
    }
    window.history.pushState({ ...base, yaacDepth: (stamp.yaacDepth ?? 0) + 1 }, '', url)
  }, [enabled, screen])
}
