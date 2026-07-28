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
