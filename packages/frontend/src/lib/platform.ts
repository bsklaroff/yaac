import type { PortMapping } from '@yaac/shared/types'

/** True when the SPA is running inside the Electron desktop shell (vs a browser). */
export function isElectron(): boolean {
  return navigator.userAgent.includes('Electron')
}

/** True on Apple platforms, where shortcuts use Cmd and are drawn with ⌘ ⌥.
 *  iPadOS Safari reports "Macintosh", which is the right treatment. */
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent)

/**
 * The bridge a native shell exposes on `window`: the Electron preload
 * (packages/desktop/src/preload.ts), or the iPhone app
 * (ios/Yaac/WebView.swift), which has no window to drive or ports to forward
 * and provides only `showServers`, `openExternal` and `openPreview`.
 */
interface YaacWindow {
  minimize?: () => void
  /** altKey selects the macOS Option-click zoom (maximize) instead of full screen. */
  toggleMaximize?: (altKey?: boolean) => void
  close?: () => void
  openExternal: (url: string) => void
  /** Show the shell's Servers page. */
  showServers: () => void
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
   * Freeze or thaw a hidden preview's page, by its `<webview>`'s
   * webContents id. Resolves whether it took effect.
   */
  setPreviewFrozen?: (webContentsId: number, frozen: boolean) => Promise<boolean>
  /** Whether a hidden preview may be discarded without losing what the
   *  user did in it (docs/preview-lifecycle.md). */
  canDiscardPreview?: (webContentsId: number) => Promise<boolean>
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
