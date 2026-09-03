import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { env } from '@yaac/shared/env'
import { formatSshCommand, torSshOpts } from '@yaac/shared/git'
import { serverLocalPath } from '@yaac/shared/paths'

/**
 * How a resolved credential becomes a git invocation the host can run:
 * the token-bearing URL, the ssh command and its known_hosts file, and the
 * environment that carries either (Tor included, when the install routes
 * through it).
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
 */
export type ResolvedGitCredential =
  | { kind: 'https'; token: string }
  | { kind: 'ssh'; privateKey: string; knownHostsEntry: string }

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
 * Build the host-side GIT_SSH_COMMAND for a registered SSH key. The server
 * has filesystem access to the key, so it uses `-i <keyPath>` directly.
 * The worktree container never sees this string — its own GIT_SSH_COMMAND is
 * built separately and uses the proxy's ssh-agent instead of `-i`.
 */
export function buildHostSideGitSshCommand(keyPath: string, knownHostsPath: string): string {
  return formatSshCommand([
    'ssh', '-F', '/dev/null',
    '-i', keyPath,
    '-o', `UserKnownHostsFile=${knownHostsPath}`,
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'IdentitiesOnly=yes',
    ...torSshOpts(),
  ])
}

/** Where the short-lived key files go: server-local, so nothing else
 *  mounts it and a sweep can own the whole directory. */
function sshKeyScratchDir(): string {
  return serverLocalPath('run', 'ssh-keys')
}

async function sshKeyScratchRoot(): Promise<string> {
  const dir = sshKeyScratchDir()
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * Empty the key scratch root. Called once at startup, which is the only
 * moment every file under it is certainly finished with: a key survives
 * `withSshKeyFile` only when the process died before its `finally`, and a
 * server that is starting has no git operation in flight.
 */
export async function sweepSshKeyScratch(): Promise<void> {
  await fs.rm(sshKeyScratchDir(), { recursive: true, force: true })
    .catch(() => { /* nothing there, or a permission hiccup — best effort */ })
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

/**
 * Run `fn` with the private key written to a file only this process can
 * read, and remove it afterwards — including when `fn` throws.
 *
 * `ssh` and `ssh-keygen` take a key as a PATH, so a key the server holds in
 * memory has to reach the filesystem to be used at all. What makes that
 * acceptable is how briefly: a 0600 file in a 0700 directory that exists for
 * one git invocation. The durable copy is the sealed row, and nothing else
 * on disk ever holds key material.
 *
 * The `finally` cannot run if the process is SIGKILLed mid-clone, so the
 * files go under one server-local root that {@link sweepSshKeyScratch}
 * empties at startup — the only moment at which every one of them is
 * certainly finished with. Under `os.tmpdir()` a survivor would sit there
 * until the OS reaped it, which on a long-lived host is never.
 */
export async function withSshKeyFile<T>(
  privateKey: string,
  fn: (keyPath: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(await sshKeyScratchRoot(), 'key-'))
  await fs.chmod(dir, 0o700)
  const keyPath = path.join(dir, 'id')
  // OpenSSH rejects a key file whose final line has no newline.
  await fs.writeFile(keyPath, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, {
    mode: 0o600,
  })
  try {
    return await fn(keyPath)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => { /* best effort */ })
  }
}

/**
 * Build the env object to pass to `simpleGit.env(...)` for a given
 * credential. For SSH, both the key and the known_hosts entry need a path on
 * disk for the GIT_SSH_COMMAND to point at; the caller writes them first
 * (`withSshKeyFile`, `ensureKnownHostsFileForCredential`) and passes them in.
 */
export function gitEnvForCredential(
  credential: ResolvedGitCredential | null,
  knownHostsPath?: string,
  keyPath?: string,
): NodeJS.ProcessEnv | undefined {
  // eslint-disable-next-line no-process-env -- forward the full host env to the git subprocess when Tor is off (torEnv spreads it when on)
  const base = torEnv() ?? { ...process.env }
  if (credential?.kind === 'ssh') {
    if (!knownHostsPath) throw new Error('SSH credentials require a knownHostsPath')
    if (!keyPath) throw new Error('SSH credentials require a key file path')
    base.GIT_SSH_COMMAND = buildHostSideGitSshCommand(keyPath, knownHostsPath)
    return base
  }
  // HTTPS or no credential: Tor env (if any) is enough; otherwise simple-git
  // can use process.env directly.
  return torEnv()
}

/** Internal to this folder: `repo.ts` needs the file on disk before it can
 *  hand git an ssh command that points at it. */
export async function ensureKnownHostsFileForCredential(
  credential: ResolvedGitCredential | null,
): Promise<string | undefined> {
  if (credential?.kind !== 'ssh') return undefined
  // Per-credential known_hosts under the OS tmp dir, keyed by content hash.
  // Stable so concurrent clones reuse the same file.
  const hash = crypto.createHash('sha256').update(credential.knownHostsEntry).digest('hex').slice(0, 12)
  const dest = path.join(os.tmpdir(), `yaac-known_hosts-${hash}`)
  await writeKnownHostsFile([credential.knownHostsEntry], dest)
  return dest
}
