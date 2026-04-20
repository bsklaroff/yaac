import fs from 'node:fs/promises'
import readline from 'node:readline/promises'
import { credentialsDir, githubCredentialsPath, ensureDataDir } from '@/lib/project/paths'
import { DaemonError } from '@/daemon/errors'
import type { GithubCredentialsFile, GithubTokenEntry } from '@/shared/types'

export function credentialsPath(): string {
  return githubCredentialsPath()
}

async function ensureCredentialsDir(): Promise<void> {
  await ensureDataDir()
  await fs.mkdir(credentialsDir(), { recursive: true, mode: 0o700 })
}

export async function loadCredentials(): Promise<GithubCredentialsFile> {
  try {
    const raw = await fs.readFile(credentialsPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as Record<string, unknown>).tokens)
    ) {
      const tokens = (parsed as Record<string, unknown>).tokens as unknown[]
      const valid = tokens.filter(
        (t): t is GithubTokenEntry =>
          typeof t === 'object' &&
          t !== null &&
          typeof (t as Record<string, unknown>).pattern === 'string' &&
          typeof (t as Record<string, unknown>).token === 'string' &&
          (t as Record<string, unknown>).token !== '',
      )
      return { tokens: valid }
    }
    return { tokens: [] }
  } catch {
    return { tokens: [] }
  }
}

export async function saveCredentials(creds: GithubCredentialsFile): Promise<void> {
  await ensureCredentialsDir()
  await fs.writeFile(
    credentialsPath(),
    JSON.stringify(creds, null, 2) + '\n',
    { mode: 0o600 },
  )
}

export { validatePattern } from '@/shared/credentials'
import { validatePattern } from '@/shared/credentials'

/**
 * Extract owner and repo from a GitHub HTTPS URL.
 * Handles https://github.com/owner/repo.git and https://github.com/owner/repo
 */
export function parseRepoPath(remoteUrl: string): { owner: string; repo: string } {
  const url = new URL(remoteUrl)
  const segments = url.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/')
  if (segments.length < 2 || !segments[0] || !segments[1]) {
    throw new Error(`Cannot parse owner/repo from URL: ${remoteUrl}`)
  }
  return { owner: segments[0], repo: segments[1] }
}

/**
 * Check if a pattern matches a given owner/repo pair.
 */
export function matchPattern(pattern: string, owner: string, repo: string): boolean {
  if (pattern === '*') return true
  const parts = pattern.split('/')
  if (parts.length !== 2) return false
  const [patOwner, patRepo] = parts
  if (patOwner !== owner) return false
  if (patRepo === '*') return true
  return patRepo === repo
}

/**
 * Resolve a token for a given remote URL by walking the token list
 * and returning the first match.
 */
export async function resolveTokenForUrl(remoteUrl: string): Promise<string | null> {
  const creds = await loadCredentials()
  if (creds.tokens.length === 0) return null
  const { owner, repo } = parseRepoPath(remoteUrl)
  for (const entry of creds.tokens) {
    if (matchPattern(entry.pattern, owner, repo)) {
      return entry.token
    }
  }
  return null
}

/**
 * Get the first available GitHub token (first token matching github.com or fallback *).
 * Backwards-compatible wrapper for callers that don't have a specific URL.
 */
export async function getGithubToken(): Promise<string | null> {
  const creds = await loadCredentials()
  return creds.tokens.length > 0 ? creds.tokens[0].token : null
}

/**
 * Add or replace a token entry. If the pattern already exists, replaces
 * the token. Otherwise inserts before the catch-all "*" entry (if any),
 * or appends.
 */
export async function addToken(pattern: string, token: string): Promise<void> {
  if (!validatePattern(pattern)) {
    throw new DaemonError('VALIDATION', 'Invalid pattern. Use *, owner/*, or owner/repo.')
  }
  if (!token) {
    throw new DaemonError('VALIDATION', 'Token cannot be empty.')
  }
  const creds = await loadCredentials()
  const existingIdx = creds.tokens.findIndex((t) => t.pattern === pattern)
  if (existingIdx >= 0) {
    creds.tokens[existingIdx].token = token
  } else {
    const catchAllIdx = creds.tokens.findIndex((t) => t.pattern === '*')
    if (catchAllIdx >= 0 && pattern !== '*') {
      creds.tokens.splice(catchAllIdx, 0, { pattern, token })
    } else {
      creds.tokens.push({ pattern, token })
    }
  }
  await saveCredentials(creds)
}

/**
 * Remove a token entry by exact pattern match. Returns true if found.
 */
export async function removeToken(pattern: string): Promise<boolean> {
  const creds = await loadCredentials()
  const idx = creds.tokens.findIndex((t) => t.pattern === pattern)
  if (idx < 0) return false
  creds.tokens.splice(idx, 1)
  await saveCredentials(creds)
  return true
}

/**
 * Remove a token or throw `NOT_FOUND`. Used by the daemon so callers
 * see a structured error for an unknown pattern.
 */
export async function removeTokenChecked(pattern: string): Promise<void> {
  const removed = await removeToken(pattern)
  if (!removed) {
    throw new DaemonError('NOT_FOUND', `No GitHub token found for pattern "${pattern}".`)
  }
}

/**
 * Replace the full token list (PUT semantics). Validates every entry.
 */
export async function replaceTokens(tokens: GithubTokenEntry[]): Promise<void> {
  for (const entry of tokens) {
    if (!entry || typeof entry.pattern !== 'string' || typeof entry.token !== 'string') {
      throw new DaemonError('VALIDATION', 'Each token entry needs a pattern and a token string.')
    }
    if (!validatePattern(entry.pattern)) {
      throw new DaemonError('VALIDATION', `Invalid pattern "${entry.pattern}".`)
    }
  }
  await saveCredentials({ tokens })
}

/**
 * List all tokens with masked values (last 4 chars visible).
 */
export async function listTokens(): Promise<Array<{ pattern: string; tokenPreview: string }>> {
  const creds = await loadCredentials()
  return creds.tokens.map((t) => ({
    pattern: t.pattern,
    tokenPreview: t.token.length > 4
      ? '***' + t.token.slice(-4)
      : '****',
  }))
}

/**
 * Interactive prompt: ask for pattern and token, then save.
 */
export async function promptForGithubToken(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('Add a GitHub Personal Access Token.')
  console.log('Pattern examples: * (default), owner/*, owner/repo')
  const pattern = (await rl.question('Repo pattern: ')).trim()
  if (!pattern) {
    rl.close()
    console.error('Pattern cannot be empty.')
    process.exit(1)
  }
  if (!validatePattern(pattern)) {
    rl.close()
    console.error('Invalid pattern. Use *, owner/*, or owner/repo.')
    process.exit(1)
  }
  const token = (await rl.question('GitHub PAT: ')).trim()
  rl.close()
  if (!token) {
    console.error('Token cannot be empty.')
    process.exit(1)
  }

  await addToken(pattern, token)
  console.log(`Token saved for pattern "${pattern}".`)
  return token
}

/**
 * Ensure at least one GitHub token is configured.
 * If none exist, prompts the user interactively.
 */
export async function ensureGithubToken(): Promise<string> {
  const creds = await loadCredentials()
  if (creds.tokens.length > 0) return creds.tokens[0].token
  return promptForGithubToken()
}
