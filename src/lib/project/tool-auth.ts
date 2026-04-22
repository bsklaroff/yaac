import fs from 'node:fs/promises'
import {
  claudeCredentialsPath,
  codexCredentialsPath,
  credentialsDir,
  ensureDataDir,
  getProjectsDir,
  claudeDir,
  codexDir,
  projectClaudeCredentialsFile,
  projectCodexAuthFile,
} from '@/lib/project/paths'
import { DaemonError } from '@/daemon/errors'
import {
  claudeOAuthBundleSchema,
  codexOAuthBundleSchema,
  type AgentTool,
  type ToolAuthKind,
  type ToolAuthEntry,
  type ClaudeCredentialsFile,
  type ClaudeOAuthBundle,
  type CodexCredentialsFile,
  type CodexOAuthBundle,
} from '@/shared/types'
import {
  detectAuthKind,
  extractClaudeOAuthBundle,
  extractCodexOAuthBundle,
  decodeJwtExp,
  readClaudeOAuthFromHost,
  readCodexOAuthFromHost,
  readCodexCredentials,
  promptForApiKey,
  runToolLogin,
  type ToolLoginResult,
} from '@/shared/tool-auth-interactive'

export {
  detectAuthKind,
  extractClaudeOAuthBundle,
  extractCodexOAuthBundle,
  decodeJwtExp,
  readClaudeOAuthFromHost,
  readCodexOAuthFromHost,
  readCodexCredentials,
  promptForApiKey,
  runToolLogin,
}
export type { ToolLoginResult }

/** Placeholder tokens written into project-local Claude credentials. */
export const PLACEHOLDER_ACCESS_TOKEN = 'yaac-ph-access'
export const PLACEHOLDER_REFRESH_TOKEN = 'yaac-ph-refresh'
/**
 * Placeholder api-key seeded into session containers (via ANTHROPIC_API_KEY or
 * OPENAI_API_KEY). The proxy only swaps the inbound credential header on
 * api.anthropic.com / api.openai.com when it equals this value — requests
 * carrying a user-supplied key pass through unchanged.
 */
export const PLACEHOLDER_API_KEY = 'yaac-ph-api-key'

async function ensureCredentialsDir(): Promise<void> {
  await ensureDataDir()
  await fs.mkdir(credentialsDir(), { recursive: true, mode: 0o700 })
}

function isClaudeOAuthBundle(v: unknown): v is ClaudeOAuthBundle {
  return claudeOAuthBundleSchema.safeParse(v).success
}

/**
 * Read the yaac-managed Claude credentials file.
 */
export async function loadClaudeCredentialsFile(): Promise<ClaudeCredentialsFile | null> {
  try {
    const raw = await fs.readFile(claudeCredentialsPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    if (o.kind === 'oauth' && typeof o.savedAt === 'string' && isClaudeOAuthBundle(o.claudeAiOauth)) {
      return { kind: 'oauth', savedAt: o.savedAt, claudeAiOauth: o.claudeAiOauth }
    }
    if (o.kind === 'api-key' && typeof o.savedAt === 'string' && typeof o.apiKey === 'string' && o.apiKey !== '') {
      return { kind: 'api-key', savedAt: o.savedAt, apiKey: o.apiKey }
    }
    return null
  } catch {
    return null
  }
}

export async function saveClaudeCredentialsFile(creds: ClaudeCredentialsFile): Promise<void> {
  await ensureCredentialsDir()
  await fs.writeFile(
    claudeCredentialsPath(),
    JSON.stringify(creds, null, 2) + '\n',
    { mode: 0o600 },
  )
}

function isCodexOAuthBundle(v: unknown): v is CodexOAuthBundle {
  return codexOAuthBundleSchema.safeParse(v).success
}

export async function loadCodexCredentialsFile(): Promise<CodexCredentialsFile | null> {
  try {
    const raw = await fs.readFile(codexCredentialsPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    if (o.kind === 'oauth' && typeof o.savedAt === 'string' && isCodexOAuthBundle(o.codexOauth)) {
      return { kind: 'oauth', savedAt: o.savedAt, codexOauth: o.codexOauth }
    }
    if (o.kind === 'api-key' && typeof o.savedAt === 'string' && typeof o.apiKey === 'string' && o.apiKey !== '') {
      return { kind: 'api-key', savedAt: o.savedAt, apiKey: o.apiKey }
    }
    return null
  } catch {
    return null
  }
}

export async function saveCodexCredentialsFile(creds: CodexCredentialsFile): Promise<void> {
  await ensureCredentialsDir()
  await fs.writeFile(
    codexCredentialsPath(),
    JSON.stringify(creds, null, 2) + '\n',
    { mode: 0o600 },
  )
}

/**
 * Save a full Codex OAuth bundle (with refresh token + expiry + id_token).
 */
export async function saveCodexOAuthBundle(bundle: CodexOAuthBundle): Promise<void> {
  await saveCodexCredentialsFile({
    kind: 'oauth',
    savedAt: new Date().toISOString(),
    codexOauth: bundle,
  })
}

/**
 * Load the stored auth entry for a specific tool.
 * Returns null if no credentials are configured.
 */
export async function loadToolAuthEntry(tool: AgentTool): Promise<ToolAuthEntry | null> {
  if (tool === 'claude') {
    const f = await loadClaudeCredentialsFile()
    if (!f) return null
    if (f.kind === 'oauth') {
      return {
        tool: 'claude',
        kind: 'oauth',
        apiKey: f.claudeAiOauth.accessToken,
        savedAt: f.savedAt,
        refreshToken: f.claudeAiOauth.refreshToken,
        expiresAt: f.claudeAiOauth.expiresAt,
        scopes: f.claudeAiOauth.scopes,
        subscriptionType: f.claudeAiOauth.subscriptionType,
      }
    }
    return { tool: 'claude', kind: 'api-key', apiKey: f.apiKey, savedAt: f.savedAt }
  }
  const f = await loadCodexCredentialsFile()
  if (!f) return null
  if (f.kind === 'oauth') {
    return {
      tool: 'codex',
      kind: 'oauth',
      apiKey: f.codexOauth.accessToken,
      savedAt: f.savedAt,
      refreshToken: f.codexOauth.refreshToken,
      expiresAt: f.codexOauth.expiresAt,
      codexBundle: f.codexOauth,
    }
  }
  return { tool: 'codex', kind: 'api-key', apiKey: f.apiKey, savedAt: f.savedAt }
}

/**
 * Save tool credentials. For Claude OAuth, callers should use
 * `saveClaudeOAuthBundle` to preserve the full bundle (refreshToken, expiresAt,
 * etc). The `apiKey` form here loses those extra fields.
 */
export async function saveToolAuth(tool: AgentTool, apiKey: string, kind: ToolAuthKind): Promise<void> {
  const savedAt = new Date().toISOString()
  if (tool === 'claude') {
    if (kind === 'oauth') {
      // OAuth without a bundle can't be refreshed — callers should use
      // saveClaudeOAuthBundle. Fall back to a minimal bundle with an already-
      // expired timestamp so the proxy will force a refresh on first use.
      await saveClaudeCredentialsFile({
        kind: 'oauth',
        savedAt,
        claudeAiOauth: {
          accessToken: apiKey,
          refreshToken: '',
          expiresAt: 0,
          scopes: [],
        },
      })
      return
    }
    await saveClaudeCredentialsFile({ kind: 'api-key', savedAt, apiKey })
    return
  }
  if (kind === 'oauth') {
    // OAuth without a bundle can't be refreshed — callers should use
    // saveCodexOAuthBundle. Fall through to api-key so the proxy still
    // injects the token until the user re-runs `yaac auth update`.
    await saveCodexCredentialsFile({ kind: 'api-key', savedAt, apiKey })
    return
  }
  await saveCodexCredentialsFile({ kind: 'api-key', savedAt, apiKey })
}

/**
 * Save a full Claude OAuth bundle (with refresh token + expiry + scopes).
 */
export async function saveClaudeOAuthBundle(bundle: ClaudeOAuthBundle): Promise<void> {
  await saveClaudeCredentialsFile({
    kind: 'oauth',
    savedAt: new Date().toISOString(),
    claudeAiOauth: bundle,
  })
}

/**
 * Remove stored auth for a specific tool. Returns true if an entry was present.
 */
export async function removeToolAuth(tool: AgentTool): Promise<boolean> {
  const target = tool === 'claude' ? claudeCredentialsPath() : codexCredentialsPath()
  try {
    await fs.unlink(target)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/**
 * Persist the result of a login flow. For Claude OAuth this stores the full
 * bundle (with refresh token + expiry) so the proxy can refresh later.
 */
export async function persistToolLogin(tool: AgentTool, result: ToolLoginResult): Promise<void> {
  if (tool === 'claude' && result.kind === 'oauth' && result.claudeBundle) {
    await saveClaudeOAuthBundle(result.claudeBundle)
    await fanOutClaudePlaceholders(result.claudeBundle)
    return
  }
  if (tool === 'codex' && result.kind === 'oauth' && result.codexBundle) {
    await saveCodexOAuthBundle(result.codexBundle)
    await fanOutCodexPlaceholders(result.codexBundle)
    return
  }
  await saveToolAuth(tool, result.apiKey, result.kind)
}

/**
 * Validate and persist a tool-auth payload the CLI sent after running
 * the native login flow locally. Throws `VALIDATION` for anything we
 * don't recognize.
 */
export async function persistToolAuthPayload(tool: AgentTool, payload: unknown): Promise<void> {
  if (tool !== 'claude' && tool !== 'codex') {
    throw new DaemonError('VALIDATION', `Unknown tool "${String(tool)}".`)
  }
  if (!payload || typeof payload !== 'object') {
    throw new DaemonError('VALIDATION', 'Expected { kind, ... } body.')
  }
  const p = payload as Record<string, unknown>
  if (p.kind === 'api-key') {
    if (typeof p.apiKey !== 'string' || p.apiKey === '') {
      throw new DaemonError('VALIDATION', 'api-key payload requires a non-empty apiKey.')
    }
    await persistToolLogin(tool, { apiKey: p.apiKey, kind: 'api-key' })
    return
  }
  if (p.kind === 'oauth') {
    if (tool === 'claude') {
      if (!isClaudeOAuthBundle(p.bundle)) {
        throw new DaemonError('VALIDATION', 'Claude oauth payload needs a valid bundle.')
      }
      await persistToolLogin('claude', {
        apiKey: p.bundle.accessToken,
        kind: 'oauth',
        claudeBundle: p.bundle,
      })
      return
    }
    if (!isCodexOAuthBundle(p.bundle)) {
      throw new DaemonError('VALIDATION', 'Codex oauth payload needs a valid bundle.')
    }
    await persistToolLogin('codex', {
      apiKey: p.bundle.accessToken,
      kind: 'oauth',
      codexBundle: p.bundle,
    })
    return
  }
  throw new DaemonError('VALIDATION', `Unknown payload kind "${String(p.kind)}".`)
}

/**
 * Ensure the given tool has stored credentials. If not, runs the native login
 * flow and saves the result.
 */
export async function ensureToolAuth(tool: AgentTool): Promise<ToolAuthEntry> {
  const existing = await loadToolAuthEntry(tool)
  if (existing) return existing

  const result = await runToolLogin(tool)
  await persistToolLogin(tool, result)
  const toolLabel = tool === 'claude' ? 'Claude Code' : 'Codex'
  console.log(`${toolLabel} credentials saved.`)
  const saved = await loadToolAuthEntry(tool)
  if (!saved) throw new Error(`Failed to persist ${toolLabel} credentials.`)
  return saved
}

/**
 * Build the placeholder bundle written into a project's `.claude/.credentials.json`.
 * Real tokens are replaced with sentinels; non-secret fields (expiresAt, scopes,
 * subscriptionType) are preserved so Claude Code inside the container sees a
 * plausible bundle and doesn't prompt for login.
 */
export function buildPlaceholderBundle(bundle: ClaudeOAuthBundle): ClaudeOAuthBundle {
  return {
    accessToken: PLACEHOLDER_ACCESS_TOKEN,
    refreshToken: PLACEHOLDER_REFRESH_TOKEN,
    expiresAt: bundle.expiresAt,
    scopes: bundle.scopes,
    subscriptionType: bundle.subscriptionType,
  }
}

/**
 * Write a placeholder `.credentials.json` to a single project's Claude dir.
 */
export async function writeProjectClaudePlaceholder(
  slug: string,
  bundle: ClaudeOAuthBundle,
): Promise<void> {
  await fs.mkdir(claudeDir(slug), { recursive: true })
  const payload = { claudeAiOauth: buildPlaceholderBundle(bundle) }
  await fs.writeFile(
    projectClaudeCredentialsFile(slug),
    JSON.stringify(payload, null, 2) + '\n',
    { mode: 0o600 },
  )
}

/**
 * After a successful Claude OAuth login, seed every existing project's
 * `.claude/.credentials.json` with a placeholder bundle. Fresh projects get
 * seeded on `project add`.
 */
export async function fanOutClaudePlaceholders(bundle: ClaudeOAuthBundle): Promise<void> {
  let projects: string[]
  try {
    projects = await fs.readdir(getProjectsDir())
  } catch {
    return
  }
  for (const slug of projects) {
    try {
      await writeProjectClaudePlaceholder(slug, bundle)
    } catch (err) {
      console.warn(`Warning: failed to seed placeholder creds for project "${slug}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * Build the placeholder Codex bundle written into a project's `auth.json`.
 * Only `accessToken` and `refreshToken` get sentineled — `idTokenRawJwt`,
 * `expiresAt`, `lastRefresh`, and `accountId` stay real so Codex's Rust
 * deserializer accepts the bundle and so the top-level `account_id` drives
 * the correct `ChatGPT-Account-Id` header on api.openai.com.
 */
export function buildCodexPlaceholderBundle(bundle: CodexOAuthBundle): CodexOAuthBundle {
  return {
    accessToken: PLACEHOLDER_ACCESS_TOKEN,
    refreshToken: PLACEHOLDER_REFRESH_TOKEN,
    idTokenRawJwt: bundle.idTokenRawJwt,
    expiresAt: bundle.expiresAt,
    lastRefresh: bundle.lastRefresh,
    accountId: bundle.accountId,
  }
}

/**
 * Write a placeholder Codex `auth.json` to a single project's codex dir.
 * The on-disk shape matches Codex's `AuthDotJson` deserializer: `auth_mode:
 * "chatgpt"`, `tokens.id_token` as a plain JWT string, plus `access_token`,
 * `refresh_token`, `account_id`, and a top-level `last_refresh`. Codex
 * re-parses the JWT claims at load time.
 */
export async function writeProjectCodexPlaceholder(
  slug: string,
  bundle: CodexOAuthBundle,
): Promise<void> {
  await fs.mkdir(codexDir(slug), { recursive: true })
  const placeholder = buildCodexPlaceholderBundle(bundle)
  const payload: Record<string, unknown> = {
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    tokens: {
      id_token: placeholder.idTokenRawJwt,
      access_token: placeholder.accessToken,
      refresh_token: placeholder.refreshToken,
      account_id: placeholder.accountId ?? null,
    },
    last_refresh: placeholder.lastRefresh,
  }
  await fs.writeFile(
    projectCodexAuthFile(slug),
    JSON.stringify(payload, null, 2) + '\n',
    { mode: 0o600 },
  )
}

/**
 * After a successful Codex OAuth login, seed every existing project's
 * `codex/auth.json` with a placeholder bundle.
 */
export async function fanOutCodexPlaceholders(bundle: CodexOAuthBundle): Promise<void> {
  let projects: string[]
  try {
    projects = await fs.readdir(getProjectsDir())
  } catch {
    return
  }
  for (const slug of projects) {
    try {
      await writeProjectCodexPlaceholder(slug, bundle)
    } catch (err) {
      console.warn(`Warning: failed to seed Codex placeholder for project "${slug}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

async function unlinkIgnoreMissing(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/**
 * Remove the project-local `.claude/.credentials.json` placeholder from
 * every tracked project. Used by `auth clear` to make sure running
 * containers don't keep using a placeholder that the proxy will no longer
 * swap for a real token.
 */
export async function cleanupProjectClaudePlaceholders(): Promise<void> {
  let projects: string[]
  try {
    projects = await fs.readdir(getProjectsDir())
  } catch {
    return
  }
  for (const slug of projects) {
    try {
      await unlinkIgnoreMissing(projectClaudeCredentialsFile(slug))
    } catch (err) {
      console.warn(`Warning: failed to remove Claude placeholder for project "${slug}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * Remove the project-local `codex/auth.json` placeholder from every tracked
 * project. Leaves the rest of the codex dir (hooks, config.toml, transcripts)
 * in place.
 */
export async function cleanupProjectCodexPlaceholders(): Promise<void> {
  let projects: string[]
  try {
    projects = await fs.readdir(getProjectsDir())
  } catch {
    return
  }
  for (const slug of projects) {
    try {
      await unlinkIgnoreMissing(projectCodexAuthFile(slug))
    } catch (err) {
      console.warn(`Warning: failed to remove Codex placeholder for project "${slug}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
