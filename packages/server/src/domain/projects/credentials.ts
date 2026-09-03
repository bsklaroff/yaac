import fs from 'node:fs/promises'
import * as childProcess from 'node:child_process'
import {
  credentialsDir,
  githubCredentialsPath,
  ensureDataDir,
} from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import { parsePattern, validatePattern, matchPattern } from '@yaac/shared/credentials'
import { expandTilde } from '@yaac/shared/paths'
import {
  deleteAllGitSshKeys,
  deleteGitSshKey,
  listGitSshKeys,
  upsertGitSshKey,
} from '#db'
import { serverLog } from '#log'
import { withSshKeyFile } from '#domain/git'
import type { ResolvedGitCredential } from '#domain/git'
import type {
  GitCredentialEntry,
  GitCredentialsFile,
  HttpsGitCredentialEntry,
  SshGitCredentialEntry,
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
 * An ssh entry in it is legacy state: {@link importLegacySshKeys} seals
 * those into rows at startup and strips them, and anything still here after
 * that had no readable key behind it (docs/legacy-compat-shims.md).
 */
function normalizeEntry(raw: Record<string, unknown>): HttpsGitCredentialEntry | null {
  const kind = raw.kind ?? 'https'
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
 * The https half: what the credentials file holds.
 *
 * Kept a file because the proxy pod reads it straight off its mount and
 * writes refreshed OAuth bundles back into that directory — moving it into a
 * sealed row means giving the proxy a push channel it does not have yet. The
 * ssh half has no such constraint and lives in the database.
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
    // An unreadable key is skipped rather than returned empty: the caller
    // would build an ssh command around nothing and fail at the remote,
    // where the cause is invisible. The store has already said which row.
    if (key.privateKey === undefined) continue
    return {
      kind: 'ssh',
      privateKey: key.privateKey,
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
 * Reject encrypted private keys: ssh-keygen exits non-zero if the key needs a
 * passphrase. We use `-P ""` so the empty-passphrase test is non-interactive.
 */
export async function assertKeyHasNoPassphrase(privateKey: string): Promise<void> {
  await withSshKeyFile(privateKey, (keyPath) => new Promise<void>((resolve, reject) => {
    const child = childProcess.spawn('ssh-keygen', ['-y', '-P', '', '-f', keyPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new ServerError(
        'VALIDATION',
        'The SSH private key could not be loaded without a passphrase. '
        + 'yaac does not prompt for passphrases; please re-encrypt the key without one '
        + `(ssh-keygen -p -f <key>) or provide an unencrypted key. (${stderr.trim()})`,
      ))
    })
  }))
}

/** What an OpenSSH private key file starts with, whatever its algorithm. */
const PEM_HEADER = /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/

/**
 * Add or replace a credential entry. Matches existing by exact pattern.
 */
export async function addEntry(entry: GitCredentialEntry): Promise<void> {
  if (!validatePattern(entry.pattern)) {
    throw new ServerError(
      'VALIDATION',
      'Invalid pattern. Use <host>/*, <host>/<path>, or <host>/<prefix>/*.',
    )
  }
  if (entry.kind === 'ssh') {
    await addSshEntry(entry)
    return
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

/**
 * Everything that can be checked about an ssh entry without writing it.
 *
 * Separate from the write so a wholesale replace can validate the whole list
 * first: the passphrase probe spawns `ssh-keygen`, so a bad entry is only
 * discovered here, and discovering it after the delete would cost every key
 * that was working.
 */
async function validateSshEntry(entry: SshGitCredentialEntry): Promise<void> {
  // Checked, never rewritten: a key file is bytes OpenSSH parses, and the one
  // thing worth normalizing (a missing trailing newline) is added where the
  // file is written.
  const privateKey = entry.privateKey
  if (!privateKey.trim()) {
    throw new ServerError('VALIDATION', 'The SSH private key cannot be empty.')
  }
  if (!PEM_HEADER.test(privateKey.trimStart())) {
    throw new ServerError(
      'VALIDATION',
      'That does not look like an SSH private key — expected a file beginning '
      + '"-----BEGIN OPENSSH PRIVATE KEY-----" (the key itself, not its path '
      + 'and not the .pub half).',
    )
  }
  if (!entry.knownHostsEntry) {
    throw new ServerError('VALIDATION', 'knownHostsEntry cannot be empty.')
  }
  await assertKeyHasNoPassphrase(privateKey)
}

/** Validate a key and seal it into its row. */
async function addSshEntry(entry: SshGitCredentialEntry): Promise<void> {
  await validateSshEntry(entry)
  await upsertGitSshKey({
    pattern: entry.pattern,
    privateKey: entry.privateKey,
    knownHostsEntry: entry.knownHostsEntry,
  })
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
 * Replace the full credential list. Validates each entry.
 */
export async function replaceEntries(entries: GitCredentialEntry[]): Promise<void> {
  for (const entry of entries) {
    if (!entry || (entry.kind !== 'https' && entry.kind !== 'ssh')) {
      throw new ServerError('VALIDATION', 'Each credential entry needs a kind of "https" or "ssh".')
    }
    if (!validatePattern(entry.pattern)) {
      throw new ServerError('VALIDATION', `Invalid pattern "${entry.pattern}".`)
    }
    if (entry.kind === 'https' && !entry.token) {
      throw new ServerError('VALIDATION', `Empty token for pattern "${entry.pattern}".`)
    }
    if (entry.kind === 'ssh' && (!entry.privateKey || !entry.knownHostsEntry)) {
      throw new ServerError(
        'VALIDATION',
        `SSH entry "${entry.pattern}" needs privateKey and knownHostsEntry.`,
      )
    }
  }
  const https = entries.filter((e): e is HttpsGitCredentialEntry => e.kind === 'https')
  const ssh = entries.filter((e): e is SshGitCredentialEntry => e.kind === 'ssh')

  // Every key is checked BEFORE anything is written. The shape checks above
  // are cheap and say nothing about the key material; these spawn
  // `ssh-keygen` and are where a pasted `.pub` or a passphrase-protected key
  // is caught. Doing them after the delete would mean one bad entry in the
  // list costs every previously-working key — a 400 the caller sees, and an
  // agent nobody re-synced.
  for (const entry of ssh) await validateSshEntry(entry)

  // The two halves live in different stores, so a wholesale replace is two
  // replaces: the file for https, the table for ssh. Each kind is emptied
  // before its entries are written, which is what makes this a replace
  // rather than a merge — an omitted ssh pattern is a removed key.
  await saveCredentials({ tokens: https })
  await deleteAllGitSshKeys()
  for (const entry of ssh) {
    await upsertGitSshKey({
      pattern: entry.pattern,
      privateKey: entry.privateKey,
      knownHostsEntry: entry.knownHostsEntry,
    })
  }
}

/** One credential as the listing shows it: never the secret itself. */
export interface CredentialSummary {
  kind: 'https' | 'ssh'
  pattern: string
  preview: string
}

/**
 * List every credential with a masked preview.
 *
 * An ssh row has no preview worth printing: the key is sealed and the
 * pattern is already the row's name, so it says where the key lives
 * instead.
 */
export async function listEntries(): Promise<CredentialSummary[]> {
  const creds = await loadCredentials()
  const https: CredentialSummary[] = creds.tokens.map((t) => ({
    kind: 'https' as const,
    pattern: t.pattern,
    preview: t.token.length > 4 ? '***' + t.token.slice(-4) : '****',
  }))
  const ssh: CredentialSummary[] = (await listGitSshKeys()).map((k) => ({
    kind: 'ssh' as const,
    pattern: k.pattern,
    preview: k.unreadable ? 'key unreadable — re-add it' : 'key stored on server (encrypted)',
  }))
  return [...https, ...ssh]
}

/**
 * Every ssh key, with the material the proxy's in-memory agent is loaded
 * from. Rows that will not open are left out — the agent cannot hold a key
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
    if (key.privateKey === undefined) continue
    out.push({
      pattern: key.pattern,
      // Safe for the same reason as loadKnownHostsEntryForHost: every stored
      // pattern was validated on the way in.
      host: parsePattern(key.pattern).host,
      privateKey: key.privateKey,
      knownHostsEntry: key.knownHostsEntry,
    })
  }
  return out
}

/**
 * Seal the ssh entries an older install left in the credentials file, once
 * (docs/legacy-compat-shims.md).
 *
 * Those entries name a path on this machine, which is why only a
 * containerless install can have a working one. The key is read while the
 * server can still read it and stored the way every key is stored now; the
 * entry is stripped either way, since nothing reads an ssh entry from this
 * file any more and leaving one would keep the file looking authoritative.
 */
export async function importLegacySshKeys(): Promise<void> {
  let raw: string
  try {
    raw = await fs.readFile(githubCredentialsPath(), 'utf8')
  } catch {
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
  const tokens = (parsed as Record<string, unknown>).tokens
  if (!Array.isArray(tokens)) return
  const isSsh = (t: unknown): t is Record<string, unknown> =>
    typeof t === 'object' && t !== null && (t as Record<string, unknown>).kind === 'ssh'
  if (!tokens.some(isSsh)) return

  // An entry is stripped only once its key is SEALED. A read can fail for
  // reasons that pass — a home not mounted yet at boot, a containerless dev
  // worktree whose private `$HOME` sends `~` somewhere else, a permission
  // hiccup — and stripping on one of those would turn a retryable failure
  // into permanent loss of the pattern and its known_hosts line, with no
  // next start to try again. `normalizeEntry` already ignores `kind: 'ssh'`,
  // so an entry left behind costs nothing but a second attempt.
  const imported = new Set<Record<string, unknown>>()
  for (const entry of tokens.filter(isSsh)) {
    const pattern = entry.pattern
    const keyPath = entry.privateKeyPath
    const knownHostsEntry = entry.knownHostsEntry
    if (typeof pattern !== 'string' || typeof keyPath !== 'string'
      || typeof knownHostsEntry !== 'string') {
      continue
    }
    // Older files carry patterns with no host axis (`owner/repo`), which the
    // writers have rejected for a while but the file may still hold. Importing
    // one verbatim would make `parsePattern` throw on every SSH create and
    // every key sync, so it is named and left where it is.
    if (!validatePattern(pattern)) {
      serverLog(
        `[legacy] the ssh credential for "${pattern}" ${patternComplaint(pattern)}; `
        + 'fix the pattern in .credentials/github.json, or re-add it with `yaac auth update`',
      )
      continue
    }
    try {
      const privateKey = await fs.readFile(expandTilde(keyPath), 'utf8')
      await upsertGitSshKey({ pattern, privateKey, knownHostsEntry })
      imported.add(entry)
      serverLog(`[legacy] stored the ssh key for "${pattern}" in the database`)
    } catch (err) {
      serverLog(
        `[legacy] the ssh credential for "${pattern}" names a key at ${keyPath} that `
        + `this server cannot read (${err instanceof Error ? err.message : String(err)}); `
        + 'it stays in the credentials file — fix the path, or re-add it with '
        + '`yaac auth update`',
      )
    }
  }
  if (imported.size === 0) return

  // Rewrite without the ones that made it, keeping whatever else the file
  // holds — including the ssh entries that did not.
  const kept = tokens.filter((t) => !(isSsh(t) && imported.has(t)))
  await ensureCredentialsDir()
  await fs.writeFile(
    githubCredentialsPath(),
    JSON.stringify({ ...(parsed as Record<string, unknown>), tokens: kept }, null, 2) + '\n',
    { mode: 0o600 },
  )
}


