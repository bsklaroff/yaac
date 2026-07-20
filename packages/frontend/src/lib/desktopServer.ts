import type {
  DesktopServerOutcome,
  DesktopServerSelection,
  DesktopServerTargets,
} from '@yaac/shared/types'

/**
 * The server-picker bridge the Electron preload exposes on `window`. Only
 * the desktop shell can re-point the machine's server attachment, so the
 * Server settings section renders solely when this bridge exists — in a
 * plain browser the tab is already attached to whichever origin served it.
 */
export interface YaacServerBridge {
  targets(): Promise<DesktopServerTargets>
  switchTo(selection: DesktopServerSelection): Promise<DesktopServerOutcome>
  addRemote(url: string, token: string): Promise<DesktopServerOutcome>
}

/** The bridge, or undefined in a browser / before the preload loads. */
export function serverBridge(): YaacServerBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { yaacServer?: YaacServerBridge }).yaacServer
}
