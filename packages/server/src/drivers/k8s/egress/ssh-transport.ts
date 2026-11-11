import path from 'node:path'
import {
  CA_SSH_KNOWN_HOSTS_KEY,
  SSH_HOST_KEY_ALIAS,
  SSH_TUNNEL_SENTINEL,
  TUNNEL_INGRESS_PORT,
} from '#drivers/k8s/substrate'
import { formatSshCommand } from '@yaac/shared/git'
import { PROXY_CA_PATH } from './proxy-client'

/**
 * The env that lets a workspace use git over SSH without holding a key
 * (docs/workspace-egress.md "Git over SSH"):
 * - the connection is an HTTP CONNECT to a sentinel address that netd
 *   redirects into the proxy, so the allowlist sees the real hostname;
 * - the proxy ends the ssh session there, as the server, and logs in to
 *   the git host itself with the key of the repo the command names. So the
 *   workspace offers no identity, and the one host key it trusts is the
 *   proxy's, under one name for every host, from the file every pod mounts
 *   beside the proxy's CA.
 * Warnings are silenced because the proxy's ssh server lacks key exchanges
 * a new OpenSSH would rather use, which it says on every connection.
 */
export function workspaceSshEnv(): string[] {
  const proxyCommand = `ncat --proxy ${SSH_TUNNEL_SENTINEL}:${TUNNEL_INGRESS_PORT}`
    + ' --proxy-type http %h %p'
  const gitSshCmd = formatSshCommand([
    'ssh', '-F', '/dev/null',
    '-o', `UserKnownHostsFile=${path.posix.dirname(PROXY_CA_PATH)}/${CA_SSH_KNOWN_HOSTS_KEY}`,
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `HostKeyAlias=${SSH_HOST_KEY_ALIAS}`,
    '-o', 'IdentityAgent=none',
    '-o', 'LogLevel=ERROR',
    '-o', `ProxyCommand=${proxyCommand}`,
  ])
  return [`GIT_SSH_COMMAND=${gitSshCmd}`]
}
