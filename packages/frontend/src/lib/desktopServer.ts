import type {
  DesktopLocalScope,
  DesktopLocalState,
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
  /** Forget a saved server other than the connected one. */
  remove(selection: DesktopServerSelection): Promise<DesktopServerOutcome>
  /** Re-run the boot flow. Used by the shell's own disconnected page. */
  retry?(): Promise<DesktopServerOutcome>
  /*
   * This Mac's installs: their state, start and stop, and the setup that
   * creates a missing one. A setup is named by its scope alone; the shell
   * owns the commands. Absent from an app older than them.
   */
  localState?(): Promise<DesktopLocalState>
  startLocal?(scope: DesktopLocalScope): Promise<DesktopServerOutcome>
  stopLocal?(scope: DesktopLocalScope): Promise<DesktopServerOutcome>
  /** Begin a setup in the background; `localState` follows it. */
  setupLocal?(scope: DesktopLocalScope): Promise<DesktopServerOutcome>
  cancelSetup?(): Promise<DesktopServerOutcome>
}

export type LocalServerBridge = Required<Pick<
  YaacServerBridge, 'localState' | 'startLocal' | 'stopLocal' | 'setupLocal' | 'cancelSetup'
>>

/** The bridge's local-server methods, when the app provides all of them. */
export function localServerBridge(bridge: YaacServerBridge | undefined): LocalServerBridge | undefined {
  if (!bridge?.localState || !bridge.startLocal || !bridge.stopLocal || !bridge.setupLocal || !bridge.cancelSetup) return undefined
  return bridge as LocalServerBridge
}

/** The bridge, or undefined in a browser / before the preload loads. */
export function serverBridge(): YaacServerBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { yaacServer?: YaacServerBridge }).yaacServer
}
