import {
  CONTAINER_ACP_DIR,
  CONTAINER_ACP_LOG_DIR,
  CONTAINER_TMUX_SOCK,
} from '@yaac/shared/paths'
import type { WorkspacePaths } from '#drivers/contract'

/**
 * Where a worktree pod's things are, as the pod itself sees them — this
 * driver's answer to `WorktreeDriver.workspacePaths`.
 *
 * Every workspace answers the SAME paths, and can: each pod has its own
 * mount namespace, so one constant per path collides with nothing. The tmux
 * socket in particular sits on a pod-local emptyDir that no other pod and
 * nothing host-side can open, which is why the paths need no workspace in
 * them and why the argument is unused.
 *
 * The constants themselves stay in `@yaac/shared/paths` because the image's
 * own scripts (`worktree-bin/yaac-worktree-init`, the acpd COPY target) are
 * built against the same spellings; this is where they enter the contract.
 */
export function k8sWorkspacePaths(): WorkspacePaths {
  return {
    tmuxSock: CONTAINER_TMUX_SOCK,
    workspaceDir: '/workspace',
    repoGitDir: '/repo/.git',
    scratchDir: '/tmp',
    acpSockDir: CONTAINER_ACP_DIR,
    acpLogDir: CONTAINER_ACP_LOG_DIR,
    acpdEntry: '/opt/yaac/acpd/main.js',
  }
}
