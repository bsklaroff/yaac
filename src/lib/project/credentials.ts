import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import * as childProcess from 'node:child_process'
import { credentialsDir, githubCredentialsPath, ensureDataDir } from '@/lib/project/paths'
import { DaemonError } from '@/daemon/errors'
import { parsePattern, validatePattern, matchPattern } from '@/shared/credentials'
import type {
  GitCredentialEntry,
  GitCredentialsFile,
  HttpsGitCredentialEntry,
} from '@/shared/types'

export { validatePattern, parsePattern, matchPattern } from '@/shared/credentials'

export function credentialsPath(): string {
  return githubCredentialsPath()
}

async function ensureCredentialsDir(): Promise<void> {
  await ensureDataDir()
  await fs.mkdir(credentialsDir(), { recursive: true, mode: 0o700 })
}

/**
 * One-way migration of legacy on-disk entries (from older yaac versions that
 * stored `{ pattern, token }` with no host axis). Catch-all `*` becomes
 * `github.com/*`; a two-segment pattern whose first segment is not a host
 * (no `.` and not `localhost`) is treated as a github.com owner.
 */
function isHostSegment(s: string): boolean {
  return s.includes('.') || s === 'localhost'
}

function normalizeLegacyPattern(pattern: string): string {
  if (pattern === '*') return 'github.com/*'
  const parts = pattern.split('/')
  if (parts.length === 2 && parts[0] && !isHostSegment(parts[0])) {
    return `github.com/${pattern}`
  }
  return pattern
}

function normalizeEntry(raw: Record<string, unknown>): GitCredentialEntry | null {
  const kind = raw.kind ?? 'https'
  if (kind === 'https') {
    if (typeof raw.pattern !== 'string' || typeof raw.token !== 'string' || !raw.token) {
      return null
    }
    const pattern = normalizeLegacyPattern(raw.pattern)
    if (!validatePattern(pattern)) return null
    return { kind: 'https', pattern, token: raw.token }
  }
  if (kind === 'ssh') {
    if (typeof raw.pattern !== 'string'
      || typeof raw.privateKeyPath !== 'string' || !raw.privateKeyPath
      || typeof raw.knownHostsEntry !== 'string' || !raw.knownHostsEntry) {
      return null
    }
    if (!validatePattern(raw.pattern)) return null
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
    const raw = await fs.readFile(credentialsPath(), 'utf8')
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
    credentialsPath(),
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
 * ports, or unparseable input.
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
    const path = url.pathname.replace(/^\//, '').replace(/\.git$/, '')
    if (!path) {
      throw new Error(`Cannot parse repo path from URL: ${remoteUrl}`)
    }
    return { scheme: 'https', host: url.hostname, path }
  }
  const m = SCP_REGEX.exec(remoteUrl)
  if (m) {
    const host = m[2]
    const path = m[3].replace(/\.git$/, '')
    if (!path) {
      throw new Error(`Cannot parse repo path from URL: ${remoteUrl}`)
    }
    return { scheme: 'ssh', host, path }
  }
  throw new Error(`Unrecognized git remote URL: "${remoteUrl}"`)
}

export type ResolvedGitCredential =
  | { kind: 'https'; token: string }
  | { kind: 'ssh'; privateKeyPath: string; knownHostsEntry: string }

function expandTilde(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
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
 * Used by session-create to assemble the container's known_hosts file.
 */
export async function loadKnownHostsEntryForHost(host: string): Promise<string | null> {
  const creds = await loadCredentials()
  for (const entry of creds.tokens) {
    if (entry.kind !== 'ssh') continue
    try {
      const parsed = parsePattern(entry.pattern)
      if (parsed.host === host) return entry.knownHostsEntry
    } catch {
      // skip
    }
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
      reject(new DaemonError(
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
    throw new DaemonError(
      'VALIDATION',
      'Invalid pattern. Use <host>/*, <host>/<path>, or <host>/<prefix>/*.',
    )
  }
  if (entry.kind === 'https' && !entry.token) {
    throw new DaemonError('VALIDATION', 'Token cannot be empty.')
  }
  if (entry.kind === 'ssh') {
    if (!entry.privateKeyPath) {
      throw new DaemonError('VALIDATION', 'privateKeyPath cannot be empty.')
    }
    if (!entry.knownHostsEntry) {
      throw new DaemonError('VALIDATION', 'knownHostsEntry cannot be empty.')
    }
    const expanded = expandTilde(entry.privateKeyPath)
    try {
      await fs.access(expanded, fs.constants.R_OK)
    } catch {
      throw new DaemonError('VALIDATION', `SSH private key not readable at ${entry.privateKeyPath}`)
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
    throw new DaemonError('NOT_FOUND', `No git credential found for pattern "${pattern}".`)
  }
}

/**
 * Replace the full credential list. Validates each entry.
 */
export async function replaceEntries(entries: GitCredentialEntry[]): Promise<void> {
  for (const entry of entries) {
    if (!entry || (entry.kind !== 'https' && entry.kind !== 'ssh')) {
      throw new DaemonError('VALIDATION', 'Each credential entry needs a kind of "https" or "ssh".')
    }
    if (!validatePattern(entry.pattern)) {
      throw new DaemonError('VALIDATION', `Invalid pattern "${entry.pattern}".`)
    }
    if (entry.kind === 'https' && !entry.token) {
      throw new DaemonError('VALIDATION', `Empty token for pattern "${entry.pattern}".`)
    }
    if (entry.kind === 'ssh' && (!entry.privateKeyPath || !entry.knownHostsEntry)) {
      throw new DaemonError(
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
    let parsed
    try {
      parsed = parsePattern(entry.pattern)
    } catch {
      continue
    }
    out.push({
      pattern: entry.pattern,
      host: parsed.host,
      privateKeyPath: expandTilde(entry.privateKeyPath),
      knownHostsEntry: entry.knownHostsEntry,
    })
  }
  return out
}

/**
 * Interactive prompt: HTTPS PAT path. SSH path lives in the CLI command
 * because it needs an ssh-keyscan helper.
 */
export async function promptForHttpsCredential(): Promise<{ pattern: string; token: string }> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('Add an HTTPS git credential (e.g. a GitHub PAT or self-hosted token).')
  console.log('Pattern examples: github.com/*, github.com/acme/*, github.com/acme/repo, gitlab.com/group/sub/*')
  const pattern = (await rl.question('Repo pattern: ')).trim()
  if (!pattern) {
    rl.close()
    console.error('Pattern cannot be empty.')
    process.exit(1)
  }
  if (!validatePattern(pattern)) {
    rl.close()
    console.error('Invalid pattern. Use <host>/*, <host>/<path>, or <host>/<prefix>/*.')
    process.exit(1)
  }
  const token = (await rl.question('Token: ')).trim()
  rl.close()
  if (!token) {
    console.error('Token cannot be empty.')
    process.exit(1)
  }
  return { pattern, token }
}

/**
 * Convenience: prompt for an HTTPS PAT and save it directly. Used by tests
 * and one-shot bootstrap paths; production CLI goes via the daemon route.
 */
export async function ensureFirstCredential(): Promise<GitCredentialEntry | null> {
  const creds = await loadCredentials()
  if (creds.tokens.length > 0) return creds.tokens[0]
  const { pattern, token } = await promptForHttpsCredential()
  const entry: HttpsGitCredentialEntry = { kind: 'https', pattern, token }
  await addEntry(entry)
  console.log(`Credential saved for pattern "${pattern}".`)
  return entry
}

