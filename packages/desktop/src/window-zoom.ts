/**
 * Decides what the custom green "zoom" button does (WindowControls.tsx →
 * preload → `window:toggle-maximize`). On macOS it mirrors the native
 * traffic light: a click toggles native full screen, and Option-click zooms
 * (maximize/unmaximize) instead. On other platforms the button is a plain
 * maximize toggle. A full-screen window always exits full screen first,
 * whatever the modifier.
 */
export type ZoomAction = 'enter-full-screen' | 'exit-full-screen' | 'maximize' | 'unmaximize'

export function zoomAction(state: {
  platform: NodeJS.Platform
  altKey: boolean
  isFullScreen: boolean
  isMaximized: boolean
}): ZoomAction {
  if (state.isFullScreen) return 'exit-full-screen'
  if (state.platform === 'darwin' && !state.altKey) return 'enter-full-screen'
  return state.isMaximized ? 'unmaximize' : 'maximize'
}

/**
 * Serializes full-screen transitions (macOS animates them and documents
 * isFullScreen() as stale until enter-/leave-full-screen fires). begin() arms
 * the guard when a transition is requested; settle() — wired to those events —
 * disarms it. A fallback timer disarms after `timeoutMs` in case a WM never
 * delivers the event; begin() and settle() cancel any pending timer, so a
 * stale timer from an earlier transition can never disarm a later one.
 */
export function createFsTransitionGuard(timeoutMs = 2000): {
  active: () => boolean
  begin: () => void
  settle: () => void
} {
  let armed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancelTimer = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return {
    active: () => armed,
    begin: () => {
      armed = true
      cancelTimer()
      timer = setTimeout(() => { armed = false; timer = null }, timeoutMs)
    },
    settle: () => {
      armed = false
      cancelTimer()
    },
  }
}
