import { useEffect } from 'react'
import { useUiStore, type MobileScreen } from '#store'

/**
 * What the mobile shell stamps on a history entry. It shares the entry with
 * whatever else lives there, which is why persistSelection's replaceState
 * preserves the object.
 *
 * `yaacDepth` counts how many entries this shell pushed to get here. It is
 * what makes the *current entry* — rather than a module counter — the record
 * of how deep we are, so nothing has to infer which direction a `popstate`
 * moved: forward and back both just land on an entry that already knows.
 */
interface ScreenState { yaacScreen?: MobileScreen; yaacDepth?: number }

/** The screen a back gesture from each screen lands on. */
const PARENT: Record<MobileScreen, MobileScreen> = {
  projects: 'projects',
  worktrees: 'projects',
  pane: 'worktrees',
}

function stampOf(state: unknown): ScreenState {
  return (state ?? {}) as ScreenState
}

/** How many entries of ours sit below the current one. Zero means a cold load:
 *  this entry is the one we started on, and `back()` would leave the app. An
 *  entry with no stamp — one from before the shell — reads as the bottom. */
function depthOf(state: unknown): number {
  return stampOf(state).yaacDepth ?? 0
}

// Set while stepping back by hand, so the sync effect replaces the current
// entry instead of pushing a new one — going back must not deepen the stack.
// Read-and-cleared at the top of that effect so it can never survive a run.
let steppingBack = false

/** Reset the module bookkeeping (exported for tests). */
export function resetMobileHistory(): void {
  steppingBack = false
}

/**
 * Go back a screen.
 *
 * The header chevrons call this rather than setting the store, so the chevron,
 * the Android back button and the iOS edge swipe are one navigation.
 *
 * The exception is a cold load that restored, say, `pane` from localStorage:
 * its single entry is the one we are standing on (depth 0), and `back()` there
 * would walk out of the app, so the chevron steps up by hand instead —
 * replacing the entry rather than pushing, since going up is undoing a level.
 */
export function goBackScreen(): void {
  if (typeof window === 'undefined') return
  if (depthOf(window.history.state) > 0) {
    window.history.back()
    return
  }
  const state = useUiStore.getState()
  const parent = PARENT[state.mobileScreen]
  // At the root there is nothing above to step to — and setting the screen to
  // itself is a store no-op, which would strand `steppingBack` set.
  if (parent === state.mobileScreen) return
  steppingBack = true
  state.setMobileScreen(parent)
}

/**
 * Mirror the mobile screen into the browser history stack.
 *
 * Advancing a screen pushes an entry; a `popstate` reads the screen back out
 * of the entry it lands on. There is deliberately no "this came from a
 * popstate" flag: after a pop the browser has already moved to that entry, so
 * the entry's stamped screen and the store's screen agree and the sync effect
 * below early-returns on its own. A flag would have to survive a store write
 * that is a no-op whenever a pop lands on a same-screen entry, and a stranded
 * one swallows the next real navigation's push.
 *
 * A deep jump — `openWorktree` from a notification landing straight on the
 * pane — pushes a single entry, so back returns to whichever screen the user
 * was on rather than stepping through a list they never saw.
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
    // Already the entry we're standing on — a pop that just moved us here, or
    // a reload whose restored screen matches the entry.
    if (stamp.yaacScreen === screen) return
    const url = window.location.pathname + window.location.search + window.location.hash
    const base = { ...(window.history.state as object | null), yaacScreen: screen }
    // Replace when there is no new place to go: the first sync stamps the
    // entry we're already on (pushing would leave a screenless entry
    // underneath that back() resolves to 'projects'), and a manual step back
    // is undoing a level, not adding one.
    if (stamp.yaacScreen === undefined || stepping) {
      window.history.replaceState({ ...base, yaacDepth: stamp.yaacDepth ?? 0 }, '', url)
      return
    }
    window.history.pushState({ ...base, yaacDepth: (stamp.yaacDepth ?? 0) + 1 }, '', url)
  }, [enabled, screen])
}
