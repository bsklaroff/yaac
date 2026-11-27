import {
  CONTAINER_ACP_DIR,
  CONTAINER_ACP_LOG_DIR,
  CONTAINER_ATTACHMENTS_DIR,
  CONTAINER_TERMINAL_LOG_DIR,
  CONTAINER_TMUX_SOCK,
} from '@yaac/shared/paths'
import type { WorkspacePaths } from '#drivers/contract'

/**
 * Where every workspace pod sees its server build's helpers folder: helper
 * commands, bundled skills and the Go daemons (`stageHelpers` in
 * packages/server/src/domain/workspaces/workspace-bin.ts, which stages the
 * daemons in its `daemons/`).
 */
export const HELPERS_DIR = '/opt/yaac/helpers'

/** streamd's binary, which `yaac-workspace-init` and `bootStreamd` start. */
export const STREAMD_BIN = `${HELPERS_DIR}/daemons/streamd`

/**
 * The k8s answer to `WorkspaceDriver.workspacePaths`: paths as seen inside
 * a workspace pod. Each pod has its own mount namespace, so every workspace
 * uses the same constant paths.
 *
 * The constants live in `@yaac/shared/paths` because the image's scripts
 * (`workspace-bin/yaac-workspace-init`) use them too.
 */
export function k8sWorkspacePaths(): WorkspacePaths {
  return {
    tmuxSock: CONTAINER_TMUX_SOCK,
    workspaceDir: '/workspace',
    scratchDir: '/tmp',
    acpSockDir: CONTAINER_ACP_DIR,
    // Required by the contract but unused: k8s pods get ssh identities
    // from the egress proxy's forwarded agent.
    sshAgentSock: '/run/yaac/ssh-agent.sock',
    acpLogDir: CONTAINER_ACP_LOG_DIR,
    terminalLogDir: CONTAINER_TERMINAL_LOG_DIR,
    attachmentsDir: CONTAINER_ATTACHMENTS_DIR,
    acpd: `${HELPERS_DIR}/daemons/acpd`,
    // On a volume the tree container shares (workspaces/pod-job.ts).
    treeTrigger: '/yaac-trigger/save',
  }
}
