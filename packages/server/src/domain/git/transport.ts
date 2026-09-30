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
 * Turns a resolved credential into a runnable git invocation: the
 * token-bearing URL, the ssh command and the public files it names, and the
 * environment (including Tor when enabled). Repository operations live in
 * `repo.ts`.
 */

/**
 * What git needs to authenticate against a remote. #domain/projects resolves
 * a project's credential to this shape so the git code needn't know about
 * projects.
 *
 * The ssh form holds no private key: signing goes through the in-process
 * agent (`agent.ts`). The public key pins ssh to one identity, and the host
 * key verifies the remote.
 */
export type ResolvedGitCredential =
  | { kind: 'https'; token: string }
  | { kind: 'ssh'; id: string; publicKey: string; knownHostsEntry: string }

export function injectTokenIntoUrl(url: string, token: string): string {
  const parsed = new URL(url)
  parsed.username = 'x-access-token'
  parsed.password = token
  return parsed.toString()
}

/**
 * Heuristic: whether a git error is a rejected credential (expired or
 * revoked token, missing scopes, rejected SSH key) rather than a network or
 * ref problem, so callers can show a "fix your credential" message.
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

/**
 * With Tor enabled, the env that routes git through the host's Tor
 * (YAAC_HOST_TOR_SOCKS_URL, default socks5h://127.0.0.1:9050). Undefined when
 * off. Includes the full process env, since `runGit` uses it as the child's
 * whole environment.
 */
export function torEnv(): NodeJS.ProcessEnv | undefined {
  if (!env.useTor) return undefined
  const url = env.torSocksUrl
  // eslint-disable-next-line no-process-env -- forward the full host env to the git subprocess (PATH/HOME/…), adding the Tor proxy vars
  return { ...process.env, ALL_PROXY: url, NO_PROXY: 'localhost,127.0.0.1' }
}

/** Write a known_hosts file atomically with mode 0600. */
export async function writeKnownHostsFile(entries: string[], destPath: string): Promise<void> {
  const content = entries.join('\n') + (entries.length ? '\n' : '')
  await fs.mkdir(path.dirname(destPath), { recursive: true })
  const tmp = `${destPath}.tmp-${crypto.randomBytes(6).toString('hex')}`
  await fs.writeFile(tmp, content, { mode: 0o600 })
  await fs.rename(tmp, destPath)
}

/** A file under `dir` named by a hash of `content`, so concurrent callers
 *  share one path. */
async function contentKeyedFile(dir: string, suffix: string, content: string): Promise<string> {
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12)
  const dest = path.join(dir, `${hash}${suffix}`)
  await writeKnownHostsFile([content], dest)
  return dest
}

/**
 * The environment for `runGit` under a credential. For ssh, writes two
 * public files: the host key (so an unknown host fails rather than being
 * trusted) and the public key (so `IdentitiesOnly` offers only this key, not
 * every key the agent holds, which could trigger a lockout). Signing uses the
 * in-process agent named by `IdentityAgent`.
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
 * Fetch a known_hosts entry for `host` using `ssh` rather than
 * `ssh-keyscan`, which can't take a ProxyCommand and so can't use Tor. With
 * `StrictHostKeyChecking=accept-new` and a temp `UserKnownHostsFile`, ssh
 * saves the host key during key exchange, before BatchMode fails auth.
 *
 * Returns the one key type ssh negotiated, which later git-over-ssh
 * connections will use. Trust on first use: the caller shows the user the
 * result.
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
