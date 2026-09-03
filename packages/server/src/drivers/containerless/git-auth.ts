import fs from 'node:fs/promises'
import path from 'node:path'
import { formatSshCommand } from '@yaac/shared/git'
import { killPids, runHost, runHostWithInput, spawnSshAgent } from './host'
import type { WorkspaceGitCredential } from '#drivers/contract'

/**
 * How a workspace's own git authenticates, on a substrate where the
 * credential it is handed is the real one.
 *
 * Nothing here is an optimization: a workspace handed no credential cannot
 * fetch or push at all. The checkout's `origin` is deliberately tokenless —
 * the clone strips it and every server-side call re-injects per invocation —
 * and the private HOME this driver gives a workspace hides the user's own
 * `~/.gitconfig` and `~/.ssh` from it. Under a pod neither matters, because
 * the egress proxy injects the credential in flight; there is no proxy here,
 * so the workspace has to hold it (docs/containerless-driver.md).
 *
 * HTTPS goes through git's own credential store rather than a token in a
 * remote URL: git worktrees share the repository's config, so a URL rewrite
 * would put the token in the server's mirror and in every sibling worktree.
 * The store's default file IS `$HOME/.git-credentials`, so the helper takes
 * no argument — no path has to survive gitconfig parsing and then a shell —
 * and the file is reaped with the worktree, since that HOME sits inside the
 * state dir teardown removes.
 *
 * SSH gets an ssh-agent of its own, one per worktree, holding the key —
 * where a pod gets the proxy's forwarded agent. The key is never written
 * into the workspace: `ssh-add` reads it from this process's stdin, the
 * agent holds it in memory, and what lands in the workspace's home is the
 * PUBLIC half, which `-i` names to pin ssh to that identity under
 * `IdentitiesOnly`. That is what keeps a stopped worktree from leaving a
 * usable private key behind on the host — the agent dies with the worktree,
 * and a state dir that outlives one (a host that rebooted before anybody
 * pressed stop) holds nothing worth having. Host verification still comes
 * from the project-scoped known_hosts the server wrote, so an unknown host
 * key fails here exactly as it does in a pod.
 *
 * Tor is deliberately not routed, unlike the server's own git commands: a
 * containerless workspace has no egress path at all, so its agent's API
 * calls and package installs already go direct, and routing this one hop
 * would suggest a confinement that does not exist.
 */

/** The file `git credential-store` reads and writes by default, relative to
 *  the HOME the workspace runs with. */
const CREDENTIALS_FILE = '.git-credentials'

/**
 * The username half of an HTTPS credential. Any value works for a PAT, and
 * this is the one the server's own URL injection and the k8s proxy's header
 * both use — so what a workspace sends is what a pod would have sent.
 */
const HTTPS_USERNAME = 'x-access-token'

export interface WorkspaceGitAuth {
  /** Sections to append to the workspace's `.gitconfig`. */
  gitconfig: string[]
  /** Environment the tmux server holds, so every pane inherits it. */
  env: Record<string, string>
  /** The ssh-agent started for this workspace, when one was — recorded in
   *  the marker so teardown ends it rather than leaking a process holding a
   *  private key. */
  agentPid?: number
}

/**
 * Put the credential where the workspace's git will find it, and report what
 * the launch still has to say in the config and the environment.
 *
 * Safe to re-run: a relaunch after a failed attempt, and a restart after a
 * token was rotated, both land on the current answer.
 */
export async function realizeGitAuth(params: {
  home: string
  credential: WorkspaceGitCredential | undefined
  knownHostsFile: string | undefined
  /** Where this workspace's ssh-agent binds, when it needs one. */
  agentSock: string
  /** The agent a previous life of this workspace left running, if any — a
   *  relaunch has to end it, or it goes on holding a key with its socket
   *  unlinked out from under it. */
  priorAgentPid?: number
}): Promise<WorkspaceGitAuth> {
  const { home, credential, knownHostsFile } = params
  const store = path.join(home, CREDENTIALS_FILE)

  // Cleared before anything is written, which covers three cases with one
  // line: a project whose remote moved to SSH, a token rotated since the last
  // launch, and the file's mode — `writeFile` applies one only when it
  // creates, so re-creating is what keeps a secret at 0600.
  await fs.rm(store, { force: true })

  if (credential === undefined) return { gitconfig: [], env: {} }

  if (credential.kind === 'https') {
    await fs.writeFile(store, `${credentialStoreLine(credential)}\n`, { mode: 0o600 })
    // The empty value first is git's own way of resetting the helper list:
    // git consults every configured helper in order and takes the first
    // answer, so a host with a system-wide helper (a keychain, a manager)
    // would otherwise answer for this project with whatever the USER has
    // stored for that host, which is not the credential yaac resolved.
    return { gitconfig: ['[credential]', '\thelper =', '\thelper = store'], env: {} }
  }

  // Both halves of an SSH remote are decided together by the caller, so one
  // without the other is a wiring bug rather than a degraded worktree — and
  // the degraded worktree would be one that skips host verification.
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
        // The PUBLIC key: with `IdentitiesOnly`, ssh reads it to pick which
        // of the agent's identities to offer, and never needs the private
        // half on disk. Naming no identity at all would let ssh try every
        // key the agent holds — including other projects' — against a host
        // that may lock the account out after a few failures.
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
 * Start this workspace's ssh-agent and load the key into it.
 *
 * Detached and in its own process group, like the tmux server beside it: the
 * agent has to outlive the create that started it, and must not die with the
 * server. Its pid goes in the workspace marker so teardown can end it and a
 * recovery scan can tell a live one from a stale socket.
 *
 * `ssh-add -` reads the key from stdin, so the private half exists only in
 * two process memories — this one and the agent's — and in neither
 * filesystem.
 */
async function startWorkspaceSshAgent(params: {
  home: string
  agentSock: string
  privateKey: string
  priorAgentPid?: number
}): Promise<{ sock: string; pid: number; publicKeyFile: string }> {
  const { home, agentSock, privateKey } = params
  // The previous life's agent, before its socket goes: unlinking alone would
  // leave it running and unreachable, still holding the key — the one thing
  // this whole arrangement exists to prevent.
  if (params.priorAgentPid !== undefined) killPids([params.priorAgentPid], 'SIGTERM')
  await fs.mkdir(path.dirname(agentSock), { recursive: true })
  // A socket left by a previous life: ssh-agent refuses to bind over one.
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
    // A half-started agent holding nothing is worse than none: ssh would
    // find a socket, offer no identity, and fail against the remote instead
    // of here where the cause is legible.
    killPids([pid], 'SIGTERM')
    await fs.rm(agentSock, { force: true }).catch(() => { /* already gone */ })
    throw err
  }
}

/**
 * One line of the credential store. Both halves are percent-encoded because
 * git url-decodes them on the way back in, and a token is opaque bytes that
 * may hold a reserved character.
 */
function credentialStoreLine(credential: { host: string; token: string }): string {
  const user = encodeURIComponent(HTTPS_USERNAME)
  return `https://${user}:${encodeURIComponent(credential.token)}@${credential.host}`
}
