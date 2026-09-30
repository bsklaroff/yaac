import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import {
  claudeCredentialsPath,
  codexCredentialsPath,
  credentialsDir,
  ensureDataDir,
  getProjectsDir,
  claudeDir,
  codexDir,
  opencodeCredentialsPath,
  piCredentialsPath,
  projectClaudeCredentialsFile,
  projectCodexAuthFile,
} from '#project-paths'
import { ServerError } from '#errors'
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
  type OpencodeCredentialsFile,
  type PiCredentialsFile,
  type ToolCredentialBundle,
} from '#types'
import {
  parseOpencodeProvider,
  parsePiProvider,
  type OpencodeProvider,
  type PiProvider,
} from '#tool-providers'
import {
  claudeKeychainService,
  deleteScopedClaudeKeychainItem,
  extractClaudeOAuthBundle,
  extractCodexOAuthBundle,
  readScopedClaudeKeychainPayload,
  type ToolLoginResult,
} from '#tool-auth-interactive'

/**
 * Shorten a rejected value before echoing it. The field is free-form, so a
 * mis-pasted api key could land in it and then in responses and logs.
 */
function truncateForMessage(value: string): string {
  return value.length > 16 ? `${value.slice(0, 16)}…` : value
}

function providerError(tool: 'opencode' | 'pi', value: string | undefined): ServerError {
  const repair = `Run \`yaac auth update ${tool}\` or pass a provider id from \`yaac-mama models\`.`
  return new ServerError(
    'VALIDATION',
    value === undefined || value === ''
      ? `${tool} credentials require a provider. ${repair}`
      : `Unknown ${tool} provider "${truncateForMessage(value)}". ${repair}`,
  )
}

/**
 * Warn when a stored credential is ignored. Otherwise it would look like the
 * tool was never configured, and the session would fail later at an
 * in-container login prompt.
 */
function warnDroppedCredential(tool: 'opencode' | 'pi', raw: unknown): void {
  const detail = typeof raw === 'string' && raw
    ? `names provider "${truncateForMessage(raw)}", which is not in this build's registry`
    : 'records no provider'
  console.warn(
    `[yaac] Ignoring the stored ${tool} credential: it ${detail}. ` +
    `Run \`yaac auth update ${tool}\` to re-record it against a current provider.`,
  )
}

/**
 * Parse a provider on a write path. A missing or unknown id throws rather
 * than being guessed, since the provider decides where the key is sent.
 */
function requireOpencodeProvider(value: string | undefined): OpencodeProvider {
  const provider = parseOpencodeProvider(value)
  if (!provider) throw providerError('opencode', value)
  return provider
}

function requirePiProvider(value: string | undefined): PiProvider {
  const provider = parsePiProvider(value)
  if (!provider) throw providerError('pi', value)
  return provider
}

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
 * Placeholder GH_TOKEN seeded into workspace containers so `gh` treats itself
 * as logged in. The proxy swaps it for the real HTTPS git token on
 * api.github.com; a user-supplied token passes through unchanged.
 */
export const PLACEHOLDER_GH_TOKEN = 'yaac-ph-gh-token'

async function ensureCredentialsDir(): Promise<void> {
  await ensureDataDir()
  await fs.mkdir(credentialsDir(), { recursive: true, mode: 0o700 })
}

function isClaudeOAuthBundle(v: unknown): v is ClaudeOAuthBundle {
  return claudeOAuthBundleSchema.safeParse(v).success
}

/** Read the yaac-managed Claude credentials file. */
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

export async function saveClaudeCredentialsFile(creds: ClaudeCredentialsFile): Promise<void> {
  await ensureCredentialsDir()
  await writeCredentialsFileAtomic(
    claudeCredentialsPath(),
    JSON.stringify(creds, null, 2) + '\n',
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
  await writeCredentialsFileAtomic(
    codexCredentialsPath(),
    JSON.stringify(creds, null, 2) + '\n',
  )
}

/** Save a full Codex OAuth bundle (refresh token, expiry, id_token). */
export async function saveCodexOAuthBundle(bundle: CodexOAuthBundle): Promise<void> {
  await saveCodexCredentialsFile({
    kind: 'oauth',
    savedAt: new Date().toISOString(),
    codexOauth: bundle,
  })
}

export async function loadOpencodeCredentialsFile(): Promise<OpencodeCredentialsFile | null> {
  try {
    const raw = await fs.readFile(opencodeCredentialsPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    if (o.kind === 'api-key' && typeof o.savedAt === 'string' && typeof o.apiKey === 'string' && o.apiKey !== '') {
      // A missing or retired provider reads as unconfigured rather than
      // defaulting, which could send the key to the wrong vendor.
      const provider = parseOpencodeProvider(
        typeof o.provider === 'string' ? o.provider : undefined,
      )
      if (!provider) {
        warnDroppedCredential('opencode', o.provider)
        return null
      }
      return { kind: 'api-key', provider, savedAt: o.savedAt, apiKey: o.apiKey }
    }
    return null
  } catch {
    return null
  }
}

export async function saveOpencodeCredentialsFile(creds: OpencodeCredentialsFile): Promise<void> {
  await ensureCredentialsDir()
  await writeCredentialsFileAtomic(
    opencodeCredentialsPath(),
    JSON.stringify(creds, null, 2) + '\n',
  )
}

export async function loadPiCredentialsFile(): Promise<PiCredentialsFile | null> {
  try {
    const raw = await fs.readFile(piCredentialsPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    if (o.kind === 'api-key' && typeof o.savedAt === 'string' && typeof o.apiKey === 'string' && o.apiKey !== '') {
      const provider = parsePiProvider(typeof o.provider === 'string' ? o.provider : undefined)
      if (!provider) {
        warnDroppedCredential('pi', o.provider)
        return null
      }
      return { kind: 'api-key', provider, savedAt: o.savedAt, apiKey: o.apiKey }
    }
    return null
  } catch {
    return null
  }
}

export async function savePiCredentialsFile(creds: PiCredentialsFile): Promise<void> {
  await ensureCredentialsDir()
  await writeCredentialsFileAtomic(
    piCredentialsPath(),
    JSON.stringify(creds, null, 2) + '\n',
  )
}

/** Every tool's stored credential file, as one value. */
export async function loadToolCredentialBundle(): Promise<ToolCredentialBundle> {
  const [claude, codex, opencode, pi] = await Promise.all([
    loadClaudeCredentialsFile(),
    loadCodexCredentialsFile(),
    loadOpencodeCredentialsFile(),
    loadPiCredentialsFile(),
  ])
  return { claude, codex, opencode, pi }
}

/**
 * Load the stored auth entry for a tool, or null if none is configured.
 * A literal argument narrows the result, e.g. `loadToolAuthEntry('pi')`
 * returns the pi variant with its required `piProvider`.
 */
export async function loadToolAuthEntry<T extends AgentTool>(
  tool: T,
): Promise<Extract<ToolAuthEntry, { tool: T }> | null> {
  // TS can't infer that each branch returns its own tool's variant.
  return loadToolAuthEntryInner(tool) as Promise<Extract<ToolAuthEntry, { tool: T }> | null>
}

async function loadToolAuthEntryInner(tool: AgentTool): Promise<ToolAuthEntry | null> {
  if (tool === 'claude') {
    const f = await loadClaudeCredentialsFile()
    if (!f) return null
    const apiKey = f.kind === 'oauth' ? f.claudeAiOauth.accessToken : f.apiKey
    return { tool: 'claude', kind: f.kind, apiKey, savedAt: f.savedAt }
  }
  if (tool === 'opencode') {
    const f = await loadOpencodeCredentialsFile()
    if (!f) return null
    return {
      tool: 'opencode',
      kind: 'api-key',
      apiKey: f.apiKey,
      savedAt: f.savedAt,
      opencodeProvider: f.provider,
    }
  }
  if (tool === 'pi') {
    const f = await loadPiCredentialsFile()
    if (!f) return null
    return {
      tool: 'pi',
      kind: 'api-key',
      apiKey: f.apiKey,
      savedAt: f.savedAt,
      piProvider: f.provider,
    }
  }
  const f = await loadCodexCredentialsFile()
  if (!f) return null
  const apiKey = f.kind === 'oauth' ? f.codexOauth.accessToken : f.apiKey
  return { tool: 'codex', kind: f.kind, apiKey, savedAt: f.savedAt }
}

/**
 * Save tool credentials. For Claude OAuth, callers should use
 * `saveClaudeOAuthBundle` to preserve the full bundle (refreshToken, expiresAt,
 * etc). The `apiKey` form here loses those extra fields.
 */
export async function saveToolAuth(
  tool: AgentTool,
  apiKey: string,
  kind: ToolAuthKind,
  /** Required for opencode/pi and validated against that tool's registry;
   *  ignored for claude/codex. */
  provider?: string,
): Promise<void> {
  const savedAt = new Date().toISOString()
  if (tool === 'claude') {
    if (kind === 'oauth') {
      // Without a full bundle (saveClaudeOAuthBundle) there is no refresh
      // token; an expired timestamp makes the proxy refresh on first use.
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
  if (tool === 'opencode') {
    // opencode and pi are api-key only (persistToolAuthPayload rejects
    // OAuth), so any kind is stored as an api key.
    await saveOpencodeCredentialsFile({
      kind: 'api-key',
      provider: requireOpencodeProvider(provider),
      savedAt,
      apiKey,
    })
    return
  }
  if (tool === 'pi') {
    await savePiCredentialsFile({
      kind: 'api-key',
      provider: requirePiProvider(provider),
      savedAt,
      apiKey,
    })
    return
  }
  // Codex OAuth without a full bundle (saveCodexOAuthBundle) can't be
  // refreshed, so the token is stored as an api key until the user re-runs
  // `yaac auth update`.
  await saveCodexCredentialsFile({ kind: 'api-key', savedAt, apiKey })
}

/** Save a full Claude OAuth bundle (refresh token, expiry, scopes). */
export async function saveClaudeOAuthBundle(bundle: ClaudeOAuthBundle): Promise<void> {
  await saveClaudeCredentialsFile({
    kind: 'oauth',
    savedAt: new Date().toISOString(),
    claudeAiOauth: bundle,
  })
}

/** Remove stored auth for a tool. Returns true if an entry was present. */
export async function removeToolAuth(tool: AgentTool): Promise<boolean> {
  const target =
    tool === 'claude' ? claudeCredentialsPath() :
    tool === 'codex' ? codexCredentialsPath() :
    tool === 'pi' ? piCredentialsPath() :
    opencodeCredentialsPath()
  try {
    await fs.unlink(target)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/**
 * Persist a login result into the host store, keeping the full OAuth bundle
 * so it can be refreshed.
 *
 * Copying it into each project's tool home is a separate step
 * (`fanOutToolCredentials` in `#domain/auth`), because whether a project
 * gets a placeholder or the real bundle depends on the driver. On the
 * server, `PUT /auth/:tool` does both.
 */
export async function persistToolLogin(tool: AgentTool, result: ToolLoginResult): Promise<void> {
  if (tool === 'claude' && result.kind === 'oauth' && result.claudeBundle) {
    await saveClaudeOAuthBundle(result.claudeBundle)
    return
  }
  if (tool === 'codex' && result.kind === 'oauth' && result.codexBundle) {
    await saveCodexOAuthBundle(result.codexBundle)
    return
  }
  // Not `piProvider ?? opencodeProvider`: ids like `openrouter` exist in
  // both registries, so the wrong tool's field could pass validation.
  const provider = tool === 'opencode' ? result.opencodeProvider
    : tool === 'pi' ? result.piProvider
    : undefined
  await saveToolAuth(tool, result.apiKey, result.kind, provider)
}

/**
 * Validate and persist a tool-auth payload the CLI sent after running the
 * native login flow locally. Throws `VALIDATION` for anything unrecognized.
 */
export async function persistToolAuthPayload(tool: AgentTool, payload: unknown): Promise<void> {
  if (tool !== 'claude' && tool !== 'codex' && tool !== 'opencode' && tool !== 'pi') {
    throw new ServerError('VALIDATION', `Unknown tool "${String(tool)}".`)
  }
  if (!payload || typeof payload !== 'object') {
    throw new ServerError('VALIDATION', 'Expected { kind, ... } body.')
  }
  const p = payload as Record<string, unknown>
  const providerRaw = typeof p.provider === 'string' ? p.provider : undefined
  if (p.kind === 'api-key') {
    if (typeof p.apiKey !== 'string' || p.apiKey === '') {
      throw new ServerError('VALIDATION', 'api-key payload requires a non-empty apiKey.')
    }
    await persistToolLogin(tool, {
      apiKey: p.apiKey,
      kind: 'api-key',
      // An unknown provider is rejected here, at the wire boundary, rather
      // than defaulted.
      opencodeProvider: tool === 'opencode' ? requireOpencodeProvider(providerRaw) : undefined,
      piProvider: tool === 'pi' ? requirePiProvider(providerRaw) : undefined,
    })
    return
  }
  if (p.kind === 'oauth') {
    if (tool === 'opencode' || tool === 'pi') {
      throw new ServerError('VALIDATION', `${tool} only supports api-key auth.`)
    }
    if (tool === 'claude') {
      if (!isClaudeOAuthBundle(p.bundle)) {
        throw new ServerError('VALIDATION', 'Claude oauth payload needs a valid bundle.')
      }
      await persistToolLogin('claude', {
        apiKey: p.bundle.accessToken,
        kind: 'oauth',
        claudeBundle: p.bundle,
      })
      return
    }
    if (!isCodexOAuthBundle(p.bundle)) {
      throw new ServerError('VALIDATION', 'Codex oauth payload needs a valid bundle.')
    }
    await persistToolLogin('codex', {
      apiKey: p.bundle.accessToken,
      kind: 'oauth',
      codexBundle: p.bundle,
    })
    return
  }
  throw new ServerError('VALIDATION', `Unknown payload kind "${String(p.kind)}".`)
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
  slug: string,
  bundle: ClaudeOAuthBundle,
): Promise<void> {
  await fs.mkdir(claudeDir(slug), { recursive: true })
  const payload = { claudeAiOauth: buildPlaceholderBundle(bundle) }
  await writeCredentialsFileAtomic(
    projectClaudeCredentialsFile(slug),
    JSON.stringify(payload, null, 2) + '\n',
  )
}

/**
 * Write the real Claude OAuth bundle into a project's `.credentials.json`,
 * for a runtime with no proxy to swap a placeholder
 * (docs/containerless-driver.md).
 */
export async function writeProjectClaudeCredentials(
  slug: string,
  bundle: ClaudeOAuthBundle,
): Promise<void> {
  await fs.mkdir(claudeDir(slug), { recursive: true })
  await writeCredentialsFileAtomic(
    projectClaudeCredentialsFile(slug),
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
export async function readProjectClaudeBundle(slug: string): Promise<ClaudeOAuthBundle | null> {
  const fromKeychain = readScopedClaudeKeychainPayload(claudeKeychainService(claudeDir(slug)))
  const raw = fromKeychain ?? await fs.readFile(projectClaudeCredentialsFile(slug), 'utf8').catch(() => null)
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
export async function readProjectCodexBundle(slug: string): Promise<CodexOAuthBundle | null> {
  const raw = await fs.readFile(projectCodexAuthFile(slug), 'utf8').catch(() => null)
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
 * Every tracked project slug. A missing projects dir reads as none.
 */
export async function listCredentialProjectSlugs(): Promise<string[]> {
  try {
    return await fs.readdir(getProjectsDir())
  } catch {
    return []
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
export function dropProjectClaudeKeychainItem(slug: string): void {
  deleteScopedClaudeKeychainItem(claudeKeychainService(claudeDir(slug)))
}

/**
 * Run `fn` for every tracked project slug. A missing projects dir is a
 * no-op; a per-project failure is warned (as `Warning: <warnLabel> for
 * project "<slug>": <message>`) and does not block the rest.
 */
async function forEachProject(
  fn: (slug: string) => Promise<void>,
  warnLabel: string,
): Promise<void> {
  let projects: string[]
  try {
    projects = await fs.readdir(getProjectsDir())
  } catch {
    return
  }
  for (const slug of projects) {
    try {
      await fn(slug)
    } catch (err) {
      console.warn(`Warning: ${warnLabel} for project "${slug}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * After a Claude OAuth login, seed every existing project's
 * `.claude/.credentials.json` with a placeholder. New projects are seeded on
 * `project add`.
 */
export async function fanOutClaudePlaceholders(bundle: ClaudeOAuthBundle): Promise<void> {
  await forEachProject((slug) => writeProjectClaudePlaceholder(slug, bundle), 'failed to seed placeholder creds')
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
  await writeCredentialsFileAtomic(
    projectCodexAuthFile(slug),
    JSON.stringify(payload, null, 2) + '\n',
  )
}

/**
 * Write the real Codex `auth.json` into a project's codex dir, for a runtime
 * with no proxy (see `writeProjectClaudeCredentials`).
 */
export async function writeProjectCodexAuth(
  slug: string,
  bundle: CodexOAuthBundle,
): Promise<void> {
  await fs.mkdir(codexDir(slug), { recursive: true })
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
    projectCodexAuthFile(slug),
    JSON.stringify(payload, null, 2) + '\n',
  )
}

/**
 * After a Codex OAuth login, seed every existing project's
 * `codex/auth.json` with a placeholder.
 */
export async function fanOutCodexPlaceholders(bundle: CodexOAuthBundle): Promise<void> {
  await forEachProject((slug) => writeProjectCodexPlaceholder(slug, bundle), 'failed to seed Codex placeholder')
}

async function unlinkIgnoreMissing(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/**
 * Remove every tracked project's claude credential, file and Keychain item,
 * so running workspaces stop using a revoked credential. Used by
 * `auth clear` and the webapp's sign-out.
 *
 * On macOS claude may have moved the live token into the project's scoped
 * Keychain item (see `readProjectClaudeBundle`), so deleting the file
 * alone is not enough. The user's own claude install is never touched.
 */
export async function cleanupProjectClaudePlaceholders(): Promise<void> {
  await forEachProject(async (slug) => {
    await unlinkIgnoreMissing(projectClaudeCredentialsFile(slug))
    deleteScopedClaudeKeychainItem(claudeKeychainService(claudeDir(slug)))
  }, 'failed to remove Claude placeholder')
}

/**
 * Remove the project-local `codex/auth.json` placeholder from every tracked
 * project. Leaves the rest of the codex dir (hooks, config.toml, transcripts)
 * in place.
 */
export async function cleanupProjectCodexPlaceholders(): Promise<void> {
  await forEachProject((slug) => unlinkIgnoreMissing(projectCodexAuthFile(slug)), 'failed to remove Codex placeholder')
}
