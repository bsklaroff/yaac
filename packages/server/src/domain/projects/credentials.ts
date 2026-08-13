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
import { serverLog } from '#log'
import type { ResolvedGitCredential } from '#domain/git'
import type {
  GitCredentialEntry,
  GitCredentialsFile,
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

function normalizeEntry(raw: Record<string, unknown>): GitCredentialEntry | null {
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
  if (kind === 'ssh') {
    if (typeof raw.pattern !== 'string'
      || typeof raw.privateKeyPath !== 'string' || !raw.privateKeyPath
      || typeof raw.knownHostsEntry !== 'string' || !raw.knownHostsEntry) {
      return null
    }
    if (!validatePattern(raw.pattern)) {
      serverLog('[credentials] ignoring ssh credential: pattern '
        + `"${raw.pattern}" ${patternComplaint(raw.pattern)}`)
      return null
    }
    return {
      kind: 'ssh',
      pattern: raw.pattern,
      privateKeyPath: raw.privateKeyPath,
      knownHostsEntry: raw.knownHostsEntry,
    }
  }
  return null
}

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
      const tokens: GitCredentialEntry[] = []
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
  const { scheme, host, path } = parseGitRemote(remoteUrl)
  const creds = await loadCredentials()
  for (const entry of creds.tokens) {
    if (entry.kind !== scheme) continue
    if (!matchPattern(entry.pattern, host, path)) continue
    if (entry.kind === 'https') return { kind: 'https', token: entry.token }
    return {
      kind: 'ssh',
      privateKeyPath: expandTilde(entry.privateKeyPath),
      knownHostsEntry: entry.knownHostsEntry,
    }
  }
  return null
}

/**
 * Return the first SSH entry's knownHostsEntry whose pattern's host matches.
 * Used by worktree-create to assemble the container's known_hosts file.
 */
export async function loadKnownHostsEntryForHost(host: string): Promise<string | null> {
  const creds = await loadCredentials()
  for (const entry of creds.tokens) {
    if (entry.kind !== 'ssh') continue
    // `parsePattern` cannot throw here: loadCredentials drops every entry
    // whose pattern doesn't validate, so anything in `tokens` parses.
    if (parsePattern(entry.pattern).host === host) return entry.knownHostsEntry
  }
  return null
}

/**
 * Reject encrypted private keys: ssh-keygen exits non-zero if the key needs a
 * passphrase. We use `-P ""` so the empty-passphrase test is non-interactive.
 */
export async function assertKeyHasNoPassphrase(keyPath: string): Promise<void> {
  const expanded = expandTilde(keyPath)
  await new Promise<void>((resolve, reject) => {
    const child = childProcess.spawn('ssh-keygen', ['-y', '-P', '', '-f', expanded], {
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
        `SSH private key at ${keyPath} could not be loaded without a passphrase. `
        + 'yaac does not prompt for passphrases; please re-encrypt the key without one '
        + `(ssh-keygen -p -f <key>) or provide an unencrypted key. (${stderr.trim()})`,
      ))
    })
  })
}

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
  if (entry.kind === 'https' && !entry.token) {
    throw new ServerError('VALIDATION', 'Token cannot be empty.')
  }
  if (entry.kind === 'ssh') {
    if (!entry.privateKeyPath) {
      throw new ServerError('VALIDATION', 'privateKeyPath cannot be empty.')
    }
    if (!entry.knownHostsEntry) {
      throw new ServerError('VALIDATION', 'knownHostsEntry cannot be empty.')
    }
    const expanded = expandTilde(entry.privateKeyPath)
    try {
      await fs.access(expanded, fs.constants.R_OK)
    } catch {
      throw new ServerError('VALIDATION', `SSH private key not readable at ${entry.privateKeyPath}`)
    }
    await assertKeyHasNoPassphrase(entry.privateKeyPath)
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
 * Remove a credential entry by exact pattern match. Returns true if found.
 */
export async function removeEntry(pattern: string): Promise<boolean> {
  const creds = await loadCredentials()
  const idx = creds.tokens.findIndex((t) => t.pattern === pattern)
  if (idx < 0) return false
  creds.tokens.splice(idx, 1)
  await saveCredentials(creds)
  return true
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
    if (entry.kind === 'ssh' && (!entry.privateKeyPath || !entry.knownHostsEntry)) {
      throw new ServerError(
        'VALIDATION',
        `SSH entry "${entry.pattern}" needs privateKeyPath and knownHostsEntry.`,
      )
    }
  }
  await saveCredentials({ tokens: entries })
}

/**
 * List all credentials with masked previews.
 */
export function summarizeEntries(creds: GitCredentialsFile): Array<{
  kind: 'https' | 'ssh'
  pattern: string
  preview: string
}> {
  return creds.tokens.map((t) => {
    if (t.kind === 'https') {
      const preview = t.token.length > 4 ? '***' + t.token.slice(-4) : '****'
      return { kind: 'https' as const, pattern: t.pattern, preview }
    }
    return { kind: 'ssh' as const, pattern: t.pattern, preview: t.privateKeyPath }
  })
}

export async function listEntries(): Promise<ReturnType<typeof summarizeEntries>> {
  return summarizeEntries(await loadCredentials())
}

/**
 * Return all SSH entries with their resolved key paths (`~`-expanded).
 * Used by proxy-client to upload keys to the proxy's ssh-agent.
 */
export async function listSshEntries(): Promise<Array<{
  pattern: string
  host: string
  privateKeyPath: string
  knownHostsEntry: string
}>> {
  const creds = await loadCredentials()
  const out: Array<{ pattern: string; host: string; privateKeyPath: string; knownHostsEntry: string }> = []
  for (const entry of creds.tokens) {
    if (entry.kind !== 'ssh') continue
    out.push({
      pattern: entry.pattern,
      // Safe for the same reason as loadKnownHostsEntryForHost: every stored
      // pattern was validated on the way in.
      host: parsePattern(entry.pattern).host,
      privateKeyPath: expandTilde(entry.privateKeyPath),
      knownHostsEntry: entry.knownHostsEntry,
    })
  }
  return out
}


