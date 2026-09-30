import {
  CONTAINER_ACP_DIR,
  CONTAINER_ACP_LOG_DIR,
  CONTAINER_ATTACHMENTS_DIR,
  CONTAINER_TMUX_SOCK,
} from '@yaac/shared/paths'
import type { WorkspacePaths } from '#drivers/contract'

/**
 * The k8s answer to `WorkspaceDriver.workspacePaths`: paths as seen inside
 * a workspace pod. Each pod has its own mount namespace, so every workspace
 * uses the same constant paths.
 *
 * The constants live in `@yaac/shared/paths` because the image's scripts
 * (`workspace-bin/yaac-workspace-init`, the acpd COPY target) use them too.
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
    attachmentsDir: CONTAINER_ATTACHMENTS_DIR,
    acpdEntry: '/opt/yaac/acpd/main.js',
  }
}
