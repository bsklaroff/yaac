import { CONTAINER_TMUX_SOCK } from '@yaac/shared/paths'
import { shellEscape } from './shell'
import type { PortMapping } from '@yaac/shared/types'

/**
 * The worktree status bar: what it says, and the command that sets it.
 *
 * Vocabulary rather than mechanism, which is why it is here. The bar reaches
 * a workspace three ways — the launch stamps `YAAC_STATUS_RIGHT` for the
 * postStart hook, the restore rewrites it over the contract's `exec` after a
 * server restart, and the reactive port-forward refreshes it from inside the
 * driver — and it must not change shape between them. Each caller runs the
 * command over whatever transport it already holds; only the strings are
 * shared.
 */
export function buildStatusRight(
  projectSlug: string,
  worktreeId: string,
  ports: ReadonlyArray<PortMapping>,
): string {
  const portInfo = ports.length > 0
    ? ' ' + ports.map((p) => `:${p.hostPort}->${p.containerPort}`).join(' ')
    : ''
  return ` ${projectSlug} ${worktreeId.slice(0, 8)}${portInfo} `
}

/** The in-workspace command that sets the bar to `value`. */
export function setStatusRightCmd(value: string): string {
  return `tmux -S ${CONTAINER_TMUX_SOCK} set-option -t yaac status-right '${shellEscape(value)}'`
}
