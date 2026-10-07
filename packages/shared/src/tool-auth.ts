import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import {
  claudeDir,
  codexDir,
  projectClaudeCredentialsFile,
  projectCodexAuthFile,
} from '#project-paths'
import type { ClaudeOAuthBundle, CodexOAuthBundle } from '#types'
import {
  claudeKeychainService,
  deleteScopedClaudeKeychainItem,
  extractClaudeOAuthBundle,
  extractCodexOAuthBundle,
  readScopedClaudeKeychainPayload,
} from '#tool-auth-interactive'

/*
 * Placeholder credentials and each project's tool-home copy of a user's
 * sign-in. The sign-ins themselves are stored by the server (`#db`
 * tool_credentials).
 */

/** Placeholder tokens written into project-local Claude credentials. */
export const PLACEHOLDER_ACCESS_TOKEN = 'yaac-ph-access'
export const PLACEHOLDER_REFRESH_TOKEN = 'yaac-ph-refresh'
/**
 * Placeholder api key seeded into workspace containers (as ANTHROPIC_API_KEY
 * or OPENAI_API_KEY). The proxy swaps the credential header on
 * api.anthropic.com / api.openai.com only when it equals this value, so a
 * user-supplied key passes through unchanged.
 */
export const PLACEHOLDER_API_KEY = 'yaac-ph-api-key'
/**
 * opencode's and pi's api-key placeholders. One per tool, so the proxy can
 * tell from the request alone whose key to swap in, even when both tools'
 * providers share a host.
 */
export const PLACEHOLDER_OPENCODE_API_KEY = 'yaac-ph-opencode-api-key'
export const PLACEHOLDER_PI_API_KEY = 'yaac-ph-pi-api-key'
/**
 * Placeholder GH_TOKEN seeded into workspace containers so `gh` treats itself
 * as logged in. The proxy swaps it for the real HTTPS git token on
 * api.github.com; a user-supplied token passes through unchanged.
 */
export const PLACEHOLDER_GH_TOKEN = 'yaac-ph-gh-token'

/**
 * Write a credentials file atomically (temp file, then rename). These files
 * are read constantly, and a reader landing mid-write on a plain `writeFile`
 * would see no credentials. The temp file is 0600 too, since its bytes are
 * secret from the moment they hit disk.
 */
async function writeCredentialsFileAtomic(filePath: string, contents: string): Promise<void> {
  const tmp = `${filePath}.tmp-${randomBytes(6).toString('hex')}`
  try {
    await fs.writeFile(tmp, contents, { mode: 0o600 })
    await fs.rename(tmp, filePath)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

/**
 * Build the placeholder bundle for a project's `.claude/.credentials.json`.
 * Tokens become sentinels; non-secret fields (expiresAt, scopes,
 * subscriptionType) are kept so Claude Code doesn't prompt for login.
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

/** Write a placeholder `.credentials.json` to one project's Claude dir. */
export async function writeProjectClaudePlaceholder(
  projectId: string,
  bundle: ClaudeOAuthBundle,
): Promise<void> {
  await fs.mkdir(claudeDir(projectId), { recursive: true })
  const payload = { claudeAiOauth: buildPlaceholderBundle(bundle) }
  await writeCredentialsFileAtomic(
    projectClaudeCredentialsFile(projectId),
    JSON.stringify(payload, null, 2) + '\n',
  )
}

/**
 * Write the real Claude OAuth bundle into a project's `.credentials.json`,
 * for a runtime with no proxy to swap a placeholder
 * (docs/containerless-driver.md).
 */
export async function writeProjectClaudeCredentials(
  projectId: string,
  bundle: ClaudeOAuthBundle,
): Promise<void> {
  await fs.mkdir(claudeDir(projectId), { recursive: true })
  await writeCredentialsFileAtomic(
    projectClaudeCredentialsFile(projectId),
    JSON.stringify({ claudeAiOauth: bundle }, null, 2) + '\n',
  )
}

/**
 * Whether a bundle is a placeholder rather than a real credential. Checked
 * before adopting a project-local bundle as the host's, which would
 * otherwise overwrite a working credential. Placeholders come from projects
 * seeded for a proxied runtime, a data dir switched from k8s to
 * containerless, or a yaac-in-yaac install (see
 * `buildFakeClaudeOAuthBundle`). Only the access token is checked, since a
 * placeholder keeps the real non-secret fields.
 */
export function isPlaceholderClaudeBundle(bundle: ClaudeOAuthBundle): boolean {
  return bundle.accessToken === PLACEHOLDER_ACCESS_TOKEN
}

/** The Codex twin of `isPlaceholderClaudeBundle`. */
export function isPlaceholderCodexBundle(bundle: CodexOAuthBundle): boolean {
  return bundle.accessToken === PLACEHOLDER_ACCESS_TOKEN
}

/**
 * Read the Claude credential a project's tool home holds, in claude's native
 * shape. With no proxy the agent refreshes its own token, so the project
 * home holds the live credential.
 *
 * On macOS claude moves the credential into the Keychain item its
 * `CLAUDE_CONFIG_DIR` names on first refresh and deletes the file, so the
 * Keychain item wins over any file. Elsewhere only the file is read.
 *
 * Placeholders are returned too; null means no parseable credential. The
 * caller decides whether a placeholder counts.
 */
export async function readProjectClaudeBundle(projectId: string): Promise<ClaudeOAuthBundle | null> {
  const fromKeychain = readScopedClaudeKeychainPayload(claudeKeychainService(claudeDir(projectId)))
  const raw = fromKeychain ?? await fs.readFile(projectClaudeCredentialsFile(projectId), 'utf8').catch(() => null)
  if (raw === null) return null
  return extractClaudeOAuthBundle(raw)
}

/**
 * Read the Codex credential a project's tool home holds, like
 * `readProjectClaudeBundle` (codex uses no Keychain).
 *
 * A file with no `last_refresh` is dated at the epoch, not now: the stamp
 * decides which of two credentials is newer, so a missing one must never
 * win. Neither codex nor yaac omits the field; this is only a guard.
 */
export async function readProjectCodexBundle(projectId: string): Promise<CodexOAuthBundle | null> {
  const raw = await fs.readFile(projectCodexAuthFile(projectId), 'utf8').catch(() => null)
  if (raw === null) return null
  const bundle = extractCodexOAuthBundle(raw)
  if (!bundle) return null
  return hasCodexRefreshStamp(raw) ? bundle : { ...bundle, lastRefresh: new Date(0).toISOString() }
}

/** Whether a raw Codex `auth.json` carries its own `last_refresh` stamp. */
function hasCodexRefreshStamp(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return false
    const stamp = (parsed as Record<string, unknown>).last_refresh
    return typeof stamp === 'string' && stamp !== ''
  } catch {
    return false
  }
}

/**
 * Drop a project's scoped Claude Keychain item so claude reads the file
 * again. Claude prefers the Keychain item, so a freshly written file would
 * otherwise be ignored. Creating an item instead would mean guessing the
 * account name claude uses. On its next refresh claude moves the file back
 * into a new item.
 *
 * `deleteScopedClaudeKeychainItem` refuses the unsuffixed service, so the
 * user's own claude install is never touched. A no-op off darwin.
 */
export function dropProjectClaudeKeychainItem(projectId: string): void {
  deleteScopedClaudeKeychainItem(claudeKeychainService(claudeDir(projectId)))
}

/**
 * Build the placeholder Codex bundle for a project's `auth.json`. Only the
 * access and refresh tokens become sentinels; the other fields stay real so
 * Codex accepts the bundle and sends the right `ChatGPT-Account-Id`.
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
 * Write a placeholder Codex `auth.json` to one project's codex dir, in the
 * shape Codex's `AuthDotJson` deserializer expects.
 */
export async function writeProjectCodexPlaceholder(
  projectId: string,
  bundle: CodexOAuthBundle,
): Promise<void> {
  await fs.mkdir(codexDir(projectId), { recursive: true })
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
  await writeCredentialsFileAtomic(
    projectCodexAuthFile(projectId),
    JSON.stringify(payload, null, 2) + '\n',
  )
}

/**
 * Write the real Codex `auth.json` into a project's codex dir, for a runtime
 * with no proxy (see `writeProjectClaudeCredentials`).
 */
export async function writeProjectCodexAuth(
  projectId: string,
  bundle: CodexOAuthBundle,
): Promise<void> {
  await fs.mkdir(codexDir(projectId), { recursive: true })
  const payload: Record<string, unknown> = {
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    tokens: {
      id_token: bundle.idTokenRawJwt,
      access_token: bundle.accessToken,
      refresh_token: bundle.refreshToken,
      account_id: bundle.accountId ?? null,
    },
    last_refresh: bundle.lastRefresh,
  }
  await writeCredentialsFileAtomic(
    projectCodexAuthFile(projectId),
    JSON.stringify(payload, null, 2) + '\n',
  )
}
