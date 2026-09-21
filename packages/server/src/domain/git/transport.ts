import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import * as childProcess from 'node:child_process'
import { env } from '@yaac/shared/env'
import { formatSshCommand, torSshOpts } from '@yaac/shared/git'
import { serverLocalPath } from '@yaac/shared/paths'
import { gitSshAgentSock } from './agent'

/**
 * How a resolved credential becomes a git invocation the host can run:
 * the token-bearing URL, the ssh command and the two public files it names,
 * and the environment that carries either (Tor included, when the install
 * routes through it).
 *
 * Separate from `repo.ts` because it is the half with no repository in it —
 * every function here is about the transport, and the operations next door
 * are what use them.
 */

/**
 * Everything git needs to authenticate against a remote, in the two forms it
 * accepts. Defined here rather than where credentials are looked up because
 * this is what consumes it: the lookup in #domain/projects resolves a
 * configured entry down to this shape precisely so the git primitives never
 * have to know about project config.
 *
 * The ssh form carries NO private material. The server's git signs through
 * the in-process agent (`agent.ts`), which opens the seed itself; what the
 * invocation needs is the public half, to pin ssh to one identity, and the
 * host key to verify the remote against.
 */
export type ResolvedGitCredential =
  | { kind: 'https'; token: string }
  | { kind: 'ssh'; pattern: string; publicKey: string; knownHostsEntry: string }

export function injectTokenIntoUrl(url: string, token: string): string {
  const parsed = new URL(url)
  parsed.username = 'x-access-token'
  parsed.password = token
  return parsed.toString()
}

/**
 * Heuristic for git transport errors caused by rejected credentials
 * (expired/revoked token, insufficient scopes, rejected SSH key), as
 * opposed to network failures or missing refs. Matches the messages git
 * emits for HTTP 401/403 and SSH auth rejection, so callers can replace
 * the raw stderr with an actionable "fix your credential" message.
 */
export function isGitAuthError(message: string): boolean {
  return [
    /authentication failed/i,
    /invalid username or password/i,
    /could not read (Username|Password)/i,
    /returned error: 40[13]/, // curl: "The requested URL returned error: 401"
    /permission denied \(publickey/i, // SSH key rejected
    /permission to .+ denied/i, // GitHub's 403 remote message on push
  ].some((re) => re.test(message))
}

// When Tor is enabled on the server process, route the git subprocess
// through the user's host-machine Tor (assumed already running at
// YAAC_HOST_TOR_SOCKS_URL, default socks5h://127.0.0.1:9050). Returns
// undefined when the toggle is off so simple-git uses its default env.
//
// simple-git's `.env(obj)` replaces the child's env wholesale, so we must
// spread process.env to preserve PATH, HOME, etc.
export function torEnv(): NodeJS.ProcessEnv | undefined {
  if (!env.useTor) return undefined
  const url = env.torSocksUrl
  // eslint-disable-next-line no-process-env -- forward the full host env to the git subprocess (PATH/HOME/…), adding the Tor proxy vars
  return { ...process.env, ALL_PROXY: url, NO_PROXY: 'localhost,127.0.0.1' }
}

/**
 * Write a known_hosts file atomically with mode 0600. Idempotent.
 */
export async function writeKnownHostsFile(entries: string[], destPath: string): Promise<void> {
  const content = entries.join('\n') + (entries.length ? '\n' : '')
  await fs.mkdir(path.dirname(destPath), { recursive: true })
  const tmp = `${destPath}.tmp-${crypto.randomBytes(6).toString('hex')}`
  await fs.writeFile(tmp, content, { mode: 0o600 })
  await fs.rename(tmp, destPath)
}

/** A stable, content-keyed file under `dir` holding `content`, for the two
 *  public files an ssh invocation names. Concurrent callers converge on
 *  the same path. */
async function contentKeyedFile(dir: string, suffix: string, content: string): Promise<string> {
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12)
  const dest = path.join(dir, `${hash}${suffix}`)
  await writeKnownHostsFile([content], dest)
  return dest
}

/**
 * The environment for `simpleGit.env(...)` under a credential.
 *
 * For ssh, two PUBLIC files are written for the command to name: the host
 * key (so an unknown host fails here rather than being trusted on first
 * use) and the public key (so ssh offers exactly this identity under
 * `IdentitiesOnly`, rather than every key the agent holds against a host
 * that may lock the account out after a few failures). Signing happens in
 * the in-process agent the `IdentityAgent` option names; nothing private is
 * written.
 */
export async function gitEnvForCredential(
  credential: ResolvedGitCredential | null,
): Promise<NodeJS.ProcessEnv | undefined> {
  if (credential?.kind !== 'ssh') return torEnv()
  const knownHostsPath = await contentKeyedFile(
    os.tmpdir(), '.known_hosts', credential.knownHostsEntry,
  )
  const publicKeyPath = await contentKeyedFile(
    serverLocalPath('run', 'ssh-pub'), '.pub', credential.publicKey,
  )
  // eslint-disable-next-line no-process-env -- forward the full host env to the git subprocess (PATH/HOME/…)
  const base = torEnv() ?? { ...process.env }
  base.GIT_SSH_COMMAND = formatSshCommand([
    'ssh', '-F', '/dev/null',
    '-o', `IdentityAgent=${gitSshAgentSock()}`,
    '-i', publicKeyPath,
    '-o', `UserKnownHostsFile=${knownHostsPath}`,
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'IdentitiesOnly=yes',
    ...torSshOpts(),
  ])
  return base
}

/**
 * Fetch a known_hosts entry for `host` by driving `ssh` (not `ssh-keyscan`).
 *
 * Why ssh: ssh-keyscan does not accept `-o ProxyCommand=…` (its `-O` flag
 * only takes `hashalg`), so it can't be routed through Tor. ssh does honor
 * `-o ProxyCommand=…`, and with StrictHostKeyChecking=accept-new +
 * UserKnownHostsFile=<tmp> it persists the negotiated host key to the temp
 * file during KEX, before BatchMode kills the auth step.
 *
 * Returns the single key type ssh actually negotiated — which is the entry
 * the subsequent git-over-ssh connection will use, so it's what we want.
 * Trust on first use, by construction: the caller shows the user what came
 * back.
 */
export async function fetchKnownHostsEntry(host: string): Promise<string> {
  const tmp = path.join(
    os.tmpdir(),
    `yaac-knownhosts-${crypto.randomBytes(6).toString('hex')}`,
  )
  await fs.writeFile(tmp, '', { mode: 0o600 })
  try {
    const args = [
      '-F', '/dev/null',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${tmp}`,
      '-o', 'HashKnownHosts=no',
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'ConnectTimeout=10',
      ...torSshOpts(),
      `nobody@${host}`,
      'true',
    ]
    let stderr = ''
    await new Promise<void>((resolve) => {
      const child = childProcess.spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
      child.on('error', () => resolve())
      child.on('close', () => resolve())
    })
    const written = await fs.readFile(tmp, 'utf8')
    const lines = written.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    if (lines.length === 0) {
      const tail = stderr.trim().split('\n').slice(-3).join(' | ')
      throw new Error(`no host key recovered for ${host}${tail ? `: ${tail}` : ''}`)
    }
    return lines[0]
  } finally {
    await fs.rm(tmp, { force: true })
  }
}
