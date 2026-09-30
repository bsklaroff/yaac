import fs from 'node:fs/promises'
import path from 'node:path'
import { formatSshCommand } from '@yaac/shared/git'
import { killPids, runHost, runHostWithInput, spawnSshAgent } from './host'
import type { WorkspaceGitCredential } from '#drivers/contract'

/**
 * Git auth for a containerless workspace, which must hold the real
 * credential: there is no proxy to inject it, the checkout's `origin` URL
 * has no token, and the private HOME hides the user's own git and ssh config
 * (docs/containerless-driver.md).
 *
 * HTTPS uses git's credential store in the workspace HOME (the default
 * `$HOME/.git-credentials`), not a token in the remote URL, and is removed
 * with the workspace's state dir.
 *
 * SSH gets a per-workspace ssh-agent. The private key is piped to `ssh-add`
 * and never written to disk; only the public key is, to pin the identity.
 * Host keys are checked against the project's known_hosts, as in a pod.
 *
 * Unlike the server's own git, this is not routed through Tor: nothing else
 * the workspace does is.
 */

/** `git credential-store`'s default file, relative to HOME. */
const CREDENTIALS_FILE = '.git-credentials'

/** Username for a PAT; the same one the server and the k8s proxy use. */
const HTTPS_USERNAME = 'x-access-token'

export interface WorkspaceGitAuth {
  /** Sections to append to the workspace's `.gitconfig`. */
  gitconfig: string[]
  /** Environment the tmux server holds, so every pane inherits it. */
  env: Record<string, string>
  /** The workspace's ssh-agent, recorded so teardown can kill it. */
  agentPid?: number
}

/**
 * Put the credential where the workspace's git finds it, and return the
 * gitconfig and env the launch must add. Idempotent.
 */
export async function realizeGitAuth(params: {
  home: string
  credential: WorkspaceGitCredential | undefined
  knownHostsFile: string | undefined
  /** Where the ssh-agent binds, if one is needed. */
  agentSock: string
  /** A previous launch's ssh-agent, to kill. */
  priorAgentPid?: number
}): Promise<WorkspaceGitAuth> {
  const { home, credential, knownHostsFile } = params
  const store = path.join(home, CREDENTIALS_FILE)

  // Always recreate: the remote may have moved to SSH, the token may have
  // rotated, and `writeFile` sets the 0600 mode only on create.
  await fs.rm(store, { force: true })

  if (credential === undefined) return { gitconfig: [], env: {} }

  if (credential.kind === 'https') {
    await fs.writeFile(store, `${credentialStoreLine(credential)}\n`, { mode: 0o600 })
    // The empty value clears inherited helpers (e.g. a system keychain) so
    // only this credential is used.
    return { gitconfig: ['[credential]', '\thelper =', '\thelper = store'], env: {} }
  }

  // A wiring bug; continuing would skip host key verification.
  if (knownHostsFile === undefined) {
    throw new Error(
      'containerless: an SSH git credential arrived without a known_hosts file',
    )
  }
  const agent = await startWorkspaceSshAgent({
    home,
    agentSock: params.agentSock,
    privateKey: credential.privateKey,
    ...(params.priorAgentPid !== undefined ? { priorAgentPid: params.priorAgentPid } : {}),
  })
  return {
    gitconfig: [],
    env: {
      SSH_AUTH_SOCK: agent.sock,
      GIT_SSH_COMMAND: formatSshCommand([
        'ssh', '-F', '/dev/null',
        // With `IdentitiesOnly`, the public key selects which agent
        // identity ssh offers.
        '-i', agent.publicKeyFile,
        '-o', `UserKnownHostsFile=${knownHostsFile}`,
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'IdentitiesOnly=yes',
      ]),
    },
    agentPid: agent.pid,
  }
}

/**
 * Start the workspace's ssh-agent (detached, so it outlives the server, like
 * tmux) and load the key into it from stdin.
 */
async function startWorkspaceSshAgent(params: {
  home: string
  agentSock: string
  privateKey: string
  priorAgentPid?: number
}): Promise<{ sock: string; pid: number; publicKeyFile: string }> {
  const { home, agentSock, privateKey } = params
  // Kill the old agent first; unlinking its socket alone would orphan it
  // with the key still loaded.
  if (params.priorAgentPid !== undefined) killPids([params.priorAgentPid], 'SIGTERM')
  await fs.mkdir(path.dirname(agentSock), { recursive: true })
  // ssh-agent will not bind over an existing socket.
  await fs.rm(agentSock, { force: true })

  const pid = await spawnSshAgent(agentSock)
  const env = { SSH_AUTH_SOCK: agentSock }
  try {
    await runHostWithInput(['ssh-add', '-'], privateKey, { env, timeoutMs: 15_000 })
    const { stdout } = await runHost(['ssh-add', '-L'], { env, timeoutMs: 10_000 })
    const sshDir = path.join(home, '.ssh')
    await fs.mkdir(sshDir, { recursive: true, mode: 0o700 })
    const publicKeyFile = path.join(sshDir, 'id.pub')
    await fs.writeFile(publicKeyFile, stdout.trimEnd() + '\n', { mode: 0o644 })
    return { sock: agentSock, pid, publicKeyFile }
  } catch (err) {
    // Do not leave an agent with no key; fail here where the cause is clear.
    killPids([pid], 'SIGTERM')
    await fs.rm(agentSock, { force: true }).catch(() => { /* already gone */ })
    throw err
  }
}

/** One credential-store line, percent-encoded since git decodes it. */
function credentialStoreLine(credential: { host: string; token: string }): string {
  const user = encodeURIComponent(HTTPS_USERNAME)
  return `https://${user}:${encodeURIComponent(credential.token)}@${credential.host}`
}
