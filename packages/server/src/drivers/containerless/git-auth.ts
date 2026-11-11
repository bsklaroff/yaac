import fs from 'node:fs/promises'
import path from 'node:path'
import { formatSshCommand } from '@yaac/shared/git'
import { HOSTED_REMOTE_PREFIX } from '@yaac/shared/hosted-git'
import { killPids, runHost, spawnSshAgent } from './host'
import type { WorkspaceGitCredential } from '#drivers/contract'

/**
 * Git auth for a containerless workspace, which must hold the real
 * credentials: there is no proxy to inject them, and a checkout's `origin`
 * URL has no token (docs/containerless-driver.md). Nothing here restricts
 * what the workspace can do with them; it only makes git pick each repo's
 * own. Its files live in the driver's state dir, which a stop removes.
 *
 * HTTPS uses git's credential store, not a token in the remote URL, named
 * with `--file`: by default `store` reads and writes the user's own
 * `~/.git-credentials`. `credential.useHttpPath` makes git ask for a
 * credential by repo path, and the store holds each repo's token under its
 * own path, so two repos on one host each get theirs.
 *
 * SSH gets a per-workspace ssh-agent holding every repo's key. A private
 * key is piped to `ssh-add` and never written to disk; only the public keys
 * are. Git runs ssh through `yaac-git-ssh`, which offers the key of the
 * repo being reached (`KEY_TABLE`). Host keys are checked against the
 * workspace's known_hosts, as in a pod.
 *
 * A hosted remote (docs/hosted-projects.md) is the server itself. A
 * checkout's `origin` names it at `yaac.internal`, as a pod sees it, so the
 * gitconfig rewrites that prefix to the server's loopback origin and sends
 * the workspace's yaac-mama token with every request to it.
 *
 * Unlike the server's own git, this is not routed through Tor: nothing else
 * the workspace does is.
 */

/** The credential store, in the driver's state dir. */
export const CREDENTIALS_FILE = 'git-credentials'

/** The table `yaac-git-ssh` reads, under the state dir's `ssh/`: one line
 *  per ssh repo, `host<TAB>path<TAB>public key file`. */
export const KEY_TABLE = 'keys'

/** The in-workspace command git runs ssh through (`workspace-bin/`). */
const GIT_SSH_WRAPPER = 'yaac-git-ssh'

/** Username for a PAT; the same one the server and the k8s proxy use. */
const HTTPS_USERNAME = 'x-access-token'

type Https = Extract<WorkspaceGitCredential, { kind: 'https' }>
type Ssh = Extract<WorkspaceGitCredential, { kind: 'ssh' }>

export interface WorkspaceGitAuth {
  /** Sections to append to the workspace's `.gitconfig`. */
  gitconfig: string[]
  /** Environment the tmux server holds, so every pane inherits it. */
  env: Record<string, string>
  /** The workspace's ssh-agent, recorded so teardown can kill it. */
  agentPid?: number
}

/**
 * Put each credential where the workspace's git finds it, and return the
 * gitconfig and env the launch must add. Idempotent.
 */
export async function realizeGitAuth(params: {
  /** The driver's state dir for this workspace. */
  dir: string
  credentials: WorkspaceGitCredential[]
  knownHostsFile: string | undefined
  /** Where the ssh-agent binds, if one is needed. */
  agentSock: string
  /** A previous launch's ssh-agent, to kill. */
  priorAgentPid?: number
}): Promise<WorkspaceGitAuth> {
  const { dir, credentials, knownHostsFile } = params
  const store = path.join(dir, CREDENTIALS_FILE)
  const gitconfig: string[] = []

  // Always recreate: a remote may have moved to SSH, a token may have
  // rotated, and `writeFile` sets the 0600 mode only on create.
  await fs.rm(store, { force: true })

  const hosted = credentials.find((c) => c.kind === 'hosted')
  if (hosted !== undefined) {
    const base = `${hosted.origin}${new URL(HOSTED_REMOTE_PREFIX).pathname}`
    gitconfig.push(
      `[url "${base}"]`,
      `\tinsteadOf = ${HOSTED_REMOTE_PREFIX}`,
      `[http "${base}"]`,
      `\textraHeader = Authorization: Bearer ${hosted.token}`,
    )
  }

  const https = credentials.filter((c): c is Https => c.kind === 'https')
  if (https.length > 0) {
    await fs.writeFile(store, https.flatMap(credentialStoreLines).join(''), { mode: 0o600 })
    // The empty value clears inherited helpers (e.g. a system keychain) so
    // only these credentials are used.
    gitconfig.push('[credential]', '\thelper =', `\thelper = store --file=${store}`, '\tuseHttpPath = true')
  }

  const ssh = credentials.filter((c): c is Ssh => c.kind === 'ssh')
  if (ssh.length === 0) return { gitconfig, env: {} }
  // A wiring bug; continuing would skip host key verification.
  if (knownHostsFile === undefined) {
    throw new Error(
      'containerless: an SSH git credential arrived without a known_hosts file',
    )
  }
  const agent = await startWorkspaceSshAgent({
    dir,
    agentSock: params.agentSock,
    credentials: ssh,
    ...(params.priorAgentPid !== undefined ? { priorAgentPid: params.priorAgentPid } : {}),
  })
  return {
    gitconfig,
    env: {
      SSH_AUTH_SOCK: agent.sock,
      GIT_SSH_COMMAND: formatSshCommand([GIT_SSH_WRAPPER, agent.keyTable, knownHostsFile]),
      // The wrapper takes OpenSSH's options; without this git would probe
      // it to find out.
      GIT_SSH_VARIANT: 'ssh',
    },
    agentPid: agent.pid,
  }
}

/**
 * Start the workspace's ssh-agent (detached, so it outlives the server, like
 * tmux), load each distinct key into it from stdin, and write the public
 * keys and the table naming which one each repo uses.
 */
async function startWorkspaceSshAgent(params: {
  dir: string
  agentSock: string
  credentials: Ssh[]
  priorAgentPid?: number
}): Promise<{ sock: string; pid: number; keyTable: string }> {
  const { dir, agentSock, credentials } = params
  // Kill the old agent first; unlinking its socket alone would orphan it
  // with the keys still loaded.
  if (params.priorAgentPid !== undefined) killPids([params.priorAgentPid], 'SIGTERM')
  await fs.mkdir(path.dirname(agentSock), { recursive: true })
  // ssh-agent will not bind over an existing socket.
  await fs.rm(agentSock, { force: true })

  const pid = await spawnSshAgent(agentSock)
  const env = { SSH_AUTH_SOCK: agentSock }
  try {
    const sshDir = path.join(dir, 'ssh')
    await fs.rm(sshDir, { recursive: true, force: true })
    await fs.mkdir(sshDir, { recursive: true, mode: 0o700 })
    // One file per distinct key, which several repos may share.
    const keyFiles = new Map<string, string>()
    for (const { privateKey, publicKey } of credentials) {
      if (keyFiles.has(publicKey)) continue
      await runHost(['ssh-add', '-'], { env, timeoutMs: 15_000, input: privateKey })
      const file = path.join(sshDir, `id-${String(keyFiles.size)}.pub`)
      await fs.writeFile(file, publicKey.trimEnd() + '\n', { mode: 0o644 })
      keyFiles.set(publicKey, file)
    }
    const keyTable = path.join(sshDir, KEY_TABLE)
    await fs.writeFile(
      keyTable,
      credentials.map((c) => `${c.host}\t${c.path}\t${keyFiles.get(c.publicKey) ?? ''}\n`).join(''),
      { mode: 0o600 },
    )
    return { sock: agentSock, pid, keyTable }
  } catch (err) {
    // Do not leave an agent with no key; fail here where the cause is clear.
    killPids([pid], 'SIGTERM')
    await fs.rm(agentSock, { force: true }).catch(() => { /* already gone */ })
    throw err
  }
}

/**
 * A repo's credential-store lines, percent-encoded since git decodes them.
 * With `useHttpPath` git matches the path whole, so one line each for the
 * spellings a request can carry: the remote with and without `.git`, and
 * the LFS endpoint under it.
 */
function credentialStoreLines(credential: Https): string[] {
  const user = encodeURIComponent(HTTPS_USERNAME)
  const base = `https://${user}:${encodeURIComponent(credential.token)}@${credential.host}/${credential.path}`
  return [base, `${base}.git`, `${base}.git/info/lfs`].map((line) => `${line}\n`)
}
