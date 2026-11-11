import { useUiStore } from '#lib/store'
import { useSnapshot } from '#lib/useSnapshot'
import type { WorkspaceRepo } from '@yaac/shared/types'

/**
 * Which of a workspace's checkouts its git views show
 * (docs/project-repos.md "Workspace layout"). The status bar, the Changes
 * pane and the Commits pane each describe one checkout; a workspace with
 * several offers a switcher (`CheckoutSwitcher`) whose pick they share.
 */
export interface CheckoutView {
  /** Whether the snapshot lists the workspace, so `repos` is its answer. */
  known: boolean
  /** The workspace's checkouts; empty for one with no repos. */
  repos: WorkspaceRepo[]
  /** The checkout shown: the pick, else the one the workspace's cwd is in,
   *  else the first. Undefined when it has none. */
  current?: WorkspaceRepo
  /** What a per-repo request sends as `repo`: the shown checkout's path
   *  when there are several, else nothing, since the server then needs
   *  none. */
  repo?: string
  /** What turns a path relative to the shown checkout into one relative to
   *  the workspace root, which the file listing uses: `''` or `<dir>/`. */
  prefix: string
}

export function useCheckout(workspaceId: string): CheckoutView {
  const workspace = useSnapshot()?.workspaces.find((w) => w.workspaceId === workspaceId)
  const pick = useUiStore((s) => s.checkoutPicks[workspaceId])
  const repos = workspace?.repos ?? NONE
  const current = repos.find((r) => r.path === pick) ?? repos.find((r) => r.path === workspace?.cwd) ?? repos[0]
  return {
    known: workspace !== undefined,
    repos,
    ...(current !== undefined ? { current } : {}),
    ...(current !== undefined && repos.length > 1 ? { repo: current.path } : {}),
    prefix: current !== undefined && current.path !== '' ? `${current.path}/` : '',
  }
}

const NONE: WorkspaceRepo[] = []

/** A checkout as a switcher or picker names it. */
export function checkoutLabel(path: string): string {
  return path === '' ? 'workspace root' : `${path}/`
}
