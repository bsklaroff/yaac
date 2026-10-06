import { shellEscape } from './shell'
import type { PortMapping } from '@yaac/shared/types'

/**
 * The workspace tmux status bar text. It is set in three places (the
 * launch's `YAAC_STATUS_RIGHT` for postStart, the restore after a server
 * restart, and the port-forward refresh inside the driver), so the format
 * is defined once here and each caller runs the command over its own
 * transport.
 */
export function buildStatusRight(workspaceId: string, ports: ReadonlyArray<PortMapping>): string {
  const portInfo = ports.length > 0
    ? ' ' + ports.map((p) => `:${p.hostPort}->${p.containerPort}`).join(' ')
    : ''
  return ` ${workspaceId.slice(0, 8)}${portInfo} `
}

/**
 * The in-workspace command that sets the bar to `value`. The tmux socket
 * is passed in because it comes from the driver (`WorkspacePaths.tmuxSock`),
 * which `#lib` cannot import.
 */
export function setStatusRightCmd(value: string, tmuxSock: string): string {
  return `tmux -S ${tmuxSock} set-option -t yaac status-right '${shellEscape(value)}'`
}
