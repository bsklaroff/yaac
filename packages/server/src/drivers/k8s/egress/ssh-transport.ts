import {
  SSH_AGENT_PORT,
  SSH_AGENT_SOCKET_PATH,
  SSH_TUNNEL_SENTINEL,
  TUNNEL_INGRESS_PORT,
} from '#drivers/k8s/substrate'
import { formatSshCommand } from '@yaac/shared/git'
import type { WorkspaceMount } from '#drivers/contract'

/** Where the project-scoped known_hosts is mounted inside the workspace. */
const CONTAINER_KNOWN_HOSTS = '/home/yaac/.ssh/yaac/known_hosts'

/**
 * The mounts and env that let a workspace use git over SSH without holding
 * a private key:
 * - identity comes from the proxy's ssh-agent, reached over TCP and
 *   re-exposed in the pod as the UNIX socket SSH_AUTH_SOCK names (a TCP hop
 *   works when the workspace runs on a different node from the proxy);
 * - host keys are checked against a project-scoped known_hosts the server
 *   wrote;
 * - the connection is an HTTP CONNECT to a sentinel address that netd
 *   redirects into the proxy, so the allowlist sees the real hostname.
 */
export function workspaceSshTransport(
  knownHostsFile: string,
  proxyHost: string,
): { mounts: WorkspaceMount[]; env: string[] } {
  const proxyCommand = `ncat --proxy ${SSH_TUNNEL_SENTINEL}:${TUNNEL_INGRESS_PORT}`
    + ' --proxy-type http %h %p'
  const gitSshCmd = formatSshCommand([
    'ssh', '-F', '/dev/null',
    '-o', `UserKnownHostsFile=${CONTAINER_KNOWN_HOSTS}`,
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'IdentitiesOnly=no',
    '-o', `ProxyCommand=${proxyCommand}`,
  ])

  return {
    mounts: [{
      source: { kind: 'hostPath', path: knownHostsFile, type: 'File' },
      mountPath: CONTAINER_KNOWN_HOSTS,
      readOnly: true,
    }],
    env: [
      `SSH_AUTH_SOCK=${SSH_AGENT_SOCKET_PATH}`,
      `GIT_SSH_COMMAND=${gitSshCmd}`,
      `YAAC_SSH_AGENT_UPSTREAM=${proxyHost}:${SSH_AGENT_PORT}`,
    ],
  }
}
