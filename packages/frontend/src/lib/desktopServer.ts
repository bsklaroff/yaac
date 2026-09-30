import type {
  DesktopServerOutcome,
  DesktopServerSelection,
  DesktopServerTargets,
} from '@yaac/shared/types'

/**
 * The server-picker bridge the Electron preload exposes on `window`. Only
 * the desktop shell can change which server the machine uses, so the Server
 * settings section renders only when this bridge exists. A browser tab is
 * tied to the origin that served it.
 */
export interface YaacServerBridge {
  targets(): Promise<DesktopServerTargets>
  switchTo(selection: DesktopServerSelection): Promise<DesktopServerOutcome>
  addRemote(url: string): Promise<DesktopServerOutcome>
  /** Re-run the boot flow. Used by the shell's own disconnected page. */
  retry?(): Promise<DesktopServerOutcome>
}

/** The bridge, or undefined in a browser / before the preload loads. */
export function serverBridge(): YaacServerBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { yaacServer?: YaacServerBridge }).yaacServer
}
