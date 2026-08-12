import {
  SSH_AGENT_PORT,
  SSH_AGENT_SOCKET_PATH,
  SSH_TUNNEL_SENTINEL,
  TUNNEL_INGRESS_PORT,
} from '#platform/k8s'
import { formatSshCommand } from '@yaac/shared/git'
import type { WorkspaceMount } from '#runtime/contract'

/** Where the project-scoped known_hosts is mounted inside the workspace. */
const CONTAINER_KNOWN_HOSTS = '/home/yaac/.ssh/yaac/known_hosts'

/**
 * How a workspace talks git over SSH without ever holding a private key.
 *
 * Three things have to be true at once, and they are assembled together
 * because each is useless without the others: identity comes from the
 * proxy's ssh-agent (forwarded, never a key on disk), host verification
 * comes from a project-scoped known_hosts the server wrote, and the
 * connection itself is tunnelled through the egress proxy so the allowlist
 * still applies to it.
 *
 * The tunnel is a CONNECT to a sentinel address that netd redirects into
 * the proxy — the same path HTTP(S) takes. CONNECT is what carries the real
 * host:port, so the allowlist sees a hostname; a raw port-22 redirect would
 * lose it. The proxy stamps the source pod IP, so identity is uniform and
 * nothing worktree-specific rides in the env.
 *
 * The agent rendezvous is a TCP hop to the proxy rather than a shared host
 * directory: the in-workspace init re-exposes it as the UNIX socket
 * SSH_AUTH_SOCK names, so a workspace scheduled away from the proxy still
 * gets an agent (a hostPath socket only meets on one node).
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
    // SHARED: written under the project dir by the server, read in-pod.
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
