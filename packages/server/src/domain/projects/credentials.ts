import fs from 'node:fs/promises'
import {
  credentialsDir,
  githubCredentialsPath,
  ensureDataDir,
} from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import { parsePattern, validatePattern, matchPattern } from '@yaac/shared/credentials'
import { deleteGitSshKey, listGitSshKeys, upsertGitSshKey } from '#db'
import { serverLog } from '#log'
import { fetchKnownHostsEntry } from '#domain/git'
import type { ResolvedGitCredential } from '#domain/git'
import { encodeOpenSshPrivateKey, generateSshKey } from '#lib/ssh-key'
import type {
  GitCredentialSummary,
  GitCredentialsFile,
  HttpsGitCredentialEntry,
} from '@yaac/shared/types'

async function ensureCredentialsDir(): Promise<void> {
  await ensureDataDir()
  await fs.mkdir(credentialsDir(), { recursive: true, mode: 0o700 })
}

/**
 * Why a stored entry was ignored, phrased for the person who has to fix it.
 *
 * Dropping one is otherwise invisible from the outside: git auth for that
 * repo simply stops, with no error at the point of use. The pattern is safe
 * to name — it is a host/path glob, never the token — and naming it is the
 * difference between a support thread and a one-line edit. A pattern with no
 * host axis is the common case, since that is the shape older yaac versions
 * wrote, so it gets the rewrite that fixes it rather than just a complaint.
 */
function patternComplaint(pattern: string): string {
  const qualified = `github.com/${pattern}`
  return validatePattern(qualified)
    ? `names no host — use "${qualified}" to mean the same thing on github.com`
    : 'is not a valid <host>/<path> pattern'
}

/**
 * One entry of the credentials FILE, which holds https tokens only.
 *
 * An ssh entry in it is what an install from before keys were sealed rows
 * wrote: a path into the user's home. It is named on the way past rather
 * than silently dropped, because the file would otherwise go on looking
 * authoritative while that project's SSH auth had stopped.
 */
function normalizeEntry(raw: Record<string, unknown>): HttpsGitCredentialEntry | null {
  const kind = raw.kind ?? 'https'
  if (kind === 'ssh') {
    serverLog(`[credentials] ignoring the ssh entry for "${String(raw.pattern)}" in `
      + '.credentials/github.json: keys are generated now — run `yaac auth update` '
      + 'to make one, then remove the entry')
    return null
  }
  if (kind === 'https') {
    if (typeof raw.pattern !== 'string' || typeof raw.token !== 'string' || !raw.token) {
      return null
    }
    if (!validatePattern(raw.pattern)) {
      serverLog('[credentials] ignoring git credential: pattern '
        + `"${raw.pattern}" ${patternComplaint(raw.pattern)}`)
      return null
    }
    return { kind: 'https', pattern: raw.pattern, token: raw.token }
  }
  return null
}

/**
 * The https half: what the credentials file holds. A file, like the tool
 * credentials beside it, and handed to the runtime with them on every
 * change; the ssh half lives in the database.
 */
export async function loadCredentials(): Promise<GitCredentialsFile> {
  try {
    const raw = await fs.readFile(githubCredentialsPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as Record<string, unknown>).tokens)
    ) {
      const rawTokens = (parsed as Record<string, unknown>).tokens as unknown[]
      const tokens: HttpsGitCredentialEntry[] = []
      for (const t of rawTokens) {
        if (t && typeof t === 'object') {
          const normalized = normalizeEntry(t as Record<string, unknown>)
          if (normalized) tokens.push(normalized)
        }
      }
      return { tokens }
    }
    return { tokens: [] }
  } catch {
    return { tokens: [] }
  }
}

export async function saveCredentials(creds: GitCredentialsFile): Promise<void> {
  await ensureCredentialsDir()
  await fs.writeFile(
    githubCredentialsPath(),
    JSON.stringify(creds, null, 2) + '\n',
    { mode: 0o600 },
  )
}

/**
 * Parse a git remote URL. Two forms are supported:
 *   - https://<host>/<path>[.git]
 *   - SCP-style: [user@]<host>:<path>[.git]
 * `<path>` may be any depth — a single segment (e.g. Gerrit-style `repo`) or
 * a deeper path (e.g. `group/sub/repo`). Throws on ssh://, http://, explicit
 * ports, or unparseable input. A trailing slash on `<path>` is stripped —
 * left in, `path.split('/').pop()` (used to derive the project slug) would
 * return an empty string instead of the repo name.
 */
export interface ParsedGitRemote {
  scheme: 'https' | 'ssh'
  host: string
  path: string
}

const SCP_REGEX = /^(?:([\w._-]+)@)?([\w.-]+):(?!\/)(.+)$/

export function parseGitRemote(remoteUrl: string): ParsedGitRemote {
  if (remoteUrl.startsWith('ssh://')) {
    throw new Error(
      'ssh:// URLs are not supported. Use SCP-style: git@host:path/to/repo',
    )
  }
  if (remoteUrl.startsWith('https://') || remoteUrl.startsWith('http://')) {
    const url = new URL(remoteUrl)
    if (url.protocol !== 'https:') {
      throw new Error(`Only HTTPS URLs are supported, got "${url.protocol}"`)
    }
    if (url.port) {
      throw new Error(`Custom HTTPS ports are not supported: "${remoteUrl}"`)
    }
    const path = url.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '')
    if (!path) {
      throw new Error(`Cannot parse repo path from URL: ${remoteUrl}`)
    }
    return { scheme: 'https', host: url.hostname, path }
  }
  const m = SCP_REGEX.exec(remoteUrl)
  if (m) {
    const host = m[2]
    const path = m[3].replace(/\/$/, '').replace(/\.git$/, '')
    if (!path) {
      throw new Error(`Cannot parse repo path from URL: ${remoteUrl}`)
    }
    return { scheme: 'ssh', host, path }
  }
  throw new Error(`Unrecognized git remote URL: "${remoteUrl}"`)
}

/**
 * Resolve a credential for a remote URL by walking the credentials file and
 * returning the first kind-matching entry whose pattern covers (host, owner,
 * repo). Returns null if nothing matches.
 */
export async function resolveCredentialForUrl(
  remoteUrl: string,
): Promise<ResolvedGitCredential | null> {
  const { scheme, host, path: repoPath } = parseGitRemote(remoteUrl)
  if (scheme === 'https') {
    const creds = await loadCredentials()
    for (const entry of creds.tokens) {
      if (!matchPattern(entry.pattern, host, repoPath)) continue
      return { kind: 'https', token: entry.token }
    }
    return null
  }
  for (const key of await listGitSshKeys()) {
    if (!matchPattern(key.pattern, host, repoPath)) continue
    // An unreadable key is skipped rather than returned: the agent would
    // refuse to sign with it and the fetch would fail at the remote, where
    // the cause is invisible. The store has already said which row.
    if (await key.openSeed() === undefined) continue
    return {
      kind: 'ssh',
      pattern: key.pattern,
      publicKey: key.publicKey,
      knownHostsEntry: key.knownHostsEntry,
    }
  }
  return null
}

/**
 * Return the first SSH entry's knownHostsEntry whose pattern's host matches.
 * Used by worktree-create to assemble the container's known_hosts file.
 */
export async function loadKnownHostsEntryForHost(host: string): Promise<string | null> {
  for (const key of await listGitSshKeys()) {
    // `parsePattern` cannot throw here: every stored pattern was validated
    // on the way in.
    if (parsePattern(key.pattern).host === host) return key.knownHostsEntry
  }
  return null
}

/**
 * Add or replace an https credential. Matches existing by exact pattern.
 */
export async function addEntry(entry: HttpsGitCredentialEntry): Promise<void> {
  if (!validatePattern(entry.pattern)) {
    throw new ServerError(
      'VALIDATION',
      'Invalid pattern. Use <host>/*, <host>/<path>, or <host>/<prefix>/*.',
    )
  }
  if (!entry.token) {
    throw new ServerError('VALIDATION', 'Token cannot be empty.')
  }
  const creds = await loadCredentials()
  const existingIdx = creds.tokens.findIndex((t) => t.pattern === entry.pattern)
  if (existingIdx >= 0) {
    creds.tokens[existingIdx] = entry
  } else {
    creds.tokens.push(entry)
  }
  await saveCredentials(creds)
}

/** What a generated key hands back: everything about it that is public. */
export interface GeneratedSshCredential {
  pattern: string
  publicKey: string
  knownHostsEntry: string
}

/**
 * Generate the SSH key for a repo pattern and seal it (docs/ssh-keys.md).
 *
 * A pattern that already has a key gets a NEW one — the row is replaced,
 * and the previous public key stops working the moment this returns. The
 * host key is fetched here unless the caller pasted one, and echoed back
 * either way so the user can compare a fingerprint: this is trust on first
 * use, and the response is where the "first use" is shown.
 */
export async function generateSshCredential(params: {
  pattern: string
  knownHostsEntry?: string
}): Promise<GeneratedSshCredential> {
  const { pattern } = params
  if (!validatePattern(pattern)) {
    throw new ServerError(
      'VALIDATION',
      'Invalid pattern. Use <host>/*, <host>/<path>, or <host>/<prefix>/*.',
    )
  }
  const host = parsePattern(pattern).host
  let knownHostsEntry = params.knownHostsEntry?.trim() ?? ''
  if (!knownHostsEntry) {
    try {
      knownHostsEntry = await fetchKnownHostsEntry(host)
    } catch (err) {
      throw new ServerError(
        'VALIDATION',
        `Could not fetch the host key for ${host} (${err instanceof Error ? err.message : String(err)}); `
        + 'paste a known_hosts line instead.',
      )
    }
  }
  const key = generateSshKey(`yaac ${pattern}`)
  await upsertGitSshKey({ pattern, seed: key.seed, publicKey: key.publicKey, knownHostsEntry })
  return { pattern, publicKey: key.publicKey, knownHostsEntry }
}

/**
 * The private key for a pattern, in the form `ssh-add -` reads — for a
 * workspace on a substrate with no proxy to sign for it, which loads it
 * into an agent of its own. Opened here and handed on, never written.
 */
export async function sshKeyMaterial(pattern: string): Promise<string> {
  const seed = await (await listGitSshKeys()).find((k) => k.pattern === pattern)?.openSeed()
  if (!seed) {
    throw new ServerError('VALIDATION', `The SSH key for "${pattern}" cannot be opened; generate a new one.`)
  }
  return encodeOpenSshPrivateKey(seed, `yaac ${pattern}`)
}

/**
 * Remove a credential entry by exact pattern match. Returns true if found.
 */
export async function removeEntry(pattern: string): Promise<boolean> {
  const creds = await loadCredentials()
  const idx = creds.tokens.findIndex((t) => t.pattern === pattern)
  if (idx >= 0) {
    creds.tokens.splice(idx, 1)
    await saveCredentials(creds)
    return true
  }
  return await deleteGitSshKey(pattern)
}

export async function removeEntryChecked(pattern: string): Promise<void> {
  const removed = await removeEntry(pattern)
  if (!removed) {
    throw new ServerError('NOT_FOUND', `No git credential found for pattern "${pattern}".`)
  }
}

/**
 * List every credential with a masked preview.
 *
 * An ssh row's preview is its public key: that is the half the user needs
 * to see, and the only half there is to show. Each row is opened here — a
 * user-initiated listing is the right place — so one the secret key no
 * longer opens is marked as needing regeneration rather than listed like a
 * good one.
 */
export async function listEntries(): Promise<GitCredentialSummary[]> {
  const creds = await loadCredentials()
  const https: GitCredentialSummary[] = creds.tokens.map((t) => ({
    kind: 'https' as const,
    pattern: t.pattern,
    preview: t.token.length > 4 ? '***' + t.token.slice(-4) : '****',
  }))
  const ssh: GitCredentialSummary[] = []
  for (const k of await listGitSshKeys()) {
    const readable = await k.openSeed() !== undefined
    ssh.push({
      kind: 'ssh' as const,
      pattern: k.pattern,
      preview: readable ? k.publicKey : `${k.publicKey} (unreadable — generate a new key)`,
      publicKey: k.publicKey,
    })
  }
  return [...https, ...ssh]
}

/**
 * Every ssh key, with the material the proxy's in-memory agent is loaded
 * from — the one listing that opens every seed, because that is what it is
 * for. Rows that will not open are left out: the agent cannot hold a key
 * the server cannot read, and the store has already logged which.
 */
export async function listSshEntries(): Promise<Array<{
  pattern: string
  host: string
  privateKey: string
  knownHostsEntry: string
}>> {
  const out: Array<{ pattern: string; host: string; privateKey: string; knownHostsEntry: string }> = []
  for (const key of await listGitSshKeys()) {
    const seed = await key.openSeed()
    if (seed === undefined) continue
    out.push({
      pattern: key.pattern,
      // Safe for the same reason as loadKnownHostsEntryForHost: every stored
      // pattern was validated on the way in.
      host: parsePattern(key.pattern).host,
      privateKey: encodeOpenSshPrivateKey(seed, `yaac ${key.pattern}`),
      knownHostsEntry: key.knownHostsEntry,
    })
  }
  return out
}
