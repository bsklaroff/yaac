import type { PortMapping } from '@yaac/shared/types'

/** True when the SPA is running inside the Electron desktop shell (vs a browser). */
export function isElectron(): boolean {
  return navigator.userAgent.includes('Electron')
}

/** True on Apple platforms, where shortcuts use Cmd and are drawn with ⌘ ⌥.
 *  iPadOS Safari reports "Macintosh", which is the right treatment. */
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent)

/** True in the desktop app's own window on macOS, which hides the native
 *  title bar, so the SPA leaves room for the traffic lights and to drag the
 *  window. On Linux and Windows the shell keeps the native frame, and a
 *  preview pane, Electron too, is no window and has no bridge. */
export function hidesTitleBar(): boolean {
  return IS_MAC && windowApi()?.app?.kind === 'desktop'
}

let covers = 0

/**
 * Hide the native traffic lights while a dialog covers the window's top
 * left corner, since web content can never draw over them. Returns the
 * release; they come back once every cover is released.
 */
export function coverTrafficLights(): () => void {
  const set = windowApi()?.setWindowButtonsVisible
  if (!set || !hidesTitleBar()) return () => {}
  if (covers++ === 0) set(false)
  return () => { if (--covers === 0) set(true) }
}

/** A native shell's description of its own build. */
export interface ShellApp {
  kind: string
  version?: string
  build?: string
  gitCommit?: string
}

/**
 * The bridge a native shell exposes on `window`: the Electron preload
 * (packages/desktop/src/preload.ts), or the iPhone app
 * (ios/Yaac/WebView.swift), which has no window to drive or ports to forward
 * and provides only `showServers`, `openExternal` and `openPreview`.
 */
interface YaacWindow {
  /** The shell's own build, which feedback reports carry (docs/feedback.md):
   *  the desktop app's version and commit, the iPhone app's version and
   *  build number. */
  app?: ShellApp
  openExternal: (url: string) => void
  /** Show the shell's Servers page. */
  showServers: () => void
  /** Show or hide the macOS traffic lights (coverTrafficLights). */
  setWindowButtonsVisible?: (visible: boolean) => void
  /**
   * Follow the local port the desktop app routes workspace hostnames at for
   * a remote server (null when it routes none): called with the current
   * port, then on every change. Returns an unsubscribe.
   */
  onHostsPort?: (cb: (port: number | null) => void) => () => void
  /**
   * Preview a workspace's forwarded port in the shell's own view, which
   * forwards it to the shell's loopback: the iPhone app's (ios/README.md
   * "Previews"). The desktop app previews in a pane instead.
   */
  openPreview?: (workspaceId: string, port: PortMapping) => void
  /**
   * Send everything a workspace's preview pane opens on loopback into that
   * workspace. Resolves true once the pane's first request would be.
   */
  routePreview?: (workspaceId: string) => Promise<boolean>
  /**
   * Freeze or thaw a hidden preview's page, by its `<webview>`'s
   * webContents id. Resolves whether it took effect.
   */
  setPreviewFrozen?: (webContentsId: number, frozen: boolean) => Promise<boolean>
  /** Whether a hidden preview may be discarded without losing what the
   *  user did in it (docs/preview-lifecycle.md). */
  canDiscardPreview?: (webContentsId: number) => Promise<boolean>
  /**
   * Be called with a preview's webContents id when Cmd/Ctrl-F is pressed
   * in its page and the page leaves it unhandled; the pane's own DOM never
   * sees the key. Returns an unsubscribe.
   */
  onPreviewFind?: (cb: (webContentsId: number) => void) => () => void
  /**
   * Be called whenever the desktop app finds critical memory pressure. The
   * app checks only while subscribed. Returns an unsubscribe.
   */
  onMemoryPressure?: (cb: () => void) => () => void
}

/** The bridge, or undefined in a browser. */
export function windowApi(): YaacWindow | undefined {
  return (window as unknown as { yaacWindow?: YaacWindow }).yaacWindow
}
