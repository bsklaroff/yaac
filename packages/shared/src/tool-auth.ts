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
 * Parse a provider for a write path, where neither a missing nor an
 * unrecognized id may be coerced: the provider determines which env var the
 * key is seeded under and which host the proxy swaps it on, so storing a
 * guess scopes the credential to a vendor the key does not belong to. Both
 * cases throw, with the message saying which happened.
 */
/**
 * Rejected values are echoed back to help the caller spot a typo, but the
 * field is a free-form string on the wire — a mis-pasted api key can land in
 * it, and from there into the response body and any logs. Echo enough to
 * identify a typo'd provider id and no more.
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
 * A dropped credential is otherwise indistinguishable from never having
 * configured the tool — `yaac auth list` just shows it signed out, and the
 * session fails later as an opaque in-container login prompt. Say so at the
 * point of the drop, naming the repair, so the cause is visible.
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
 * Placeholder api-key seeded into session containers (via ANTHROPIC_API_KEY or
 * OPENAI_API_KEY). The proxy only swaps the inbound credential header on
 * api.anthropic.com / api.openai.com when it equals this value — requests
 * carrying a user-supplied key pass through unchanged.
 */
export const PLACEHOLDER_API_KEY = 'yaac-ph-api-key'
/**
 * Placeholder GH_TOKEN seeded into session containers so the GitHub CLI (`gh`)
 * treats itself as logged in. The proxy swaps it for the session's real HTTPS
 * git token on api.github.com requests carrying this sentinel; gh traffic with
 * a user-supplied token passes through unchanged.
 */
export const PLACEHOLDER_GH_TOKEN = 'yaac-ph-gh-token'

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

/**
 * Write a credentials file atomically: same-directory temp file, then
 * rename. These files are read concurrently and continuously — the
 * plan-usage poller, every session registration, the proxy's injection
 * path — and a plain `writeFile` truncates in place, so a reader that
 * lands mid-write sees an empty or half-written file and concludes there
 * are no credentials. `rename(2)` within a directory is atomic, so a
 * reader sees either the old file or the new one.
 *
 * 0600 on the temp file, not just the final one: the bytes are
 * bearer-equivalent from the moment they hit disk.
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

export async function loadOpencodeCredentialsFile(): Promise<OpencodeCredentialsFile | null> {
  try {
    const raw = await fs.readFile(opencodeCredentialsPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    if (o.kind === 'api-key' && typeof o.savedAt === 'string' && typeof o.apiKey === 'string' && o.apiKey !== '') {
      // The provider must be recorded and still exist in the registry. A file
      // missing one (written before the field existed) or naming an id a regen
      // retired reads as unconfigured rather than being coerced to a default —
      // that would inject this key on a vendor the user never chose. Re-running
      // `yaac auth` repairs it.
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
      // Missing or unknown stored provider → unusable, as for opencode above.
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

/**
 * Load the stored auth entry for a specific tool.
 * Returns null if no credentials are configured.
 */
/**
 * Generic in the tool so a literal argument narrows the result:
 * `loadToolAuthEntry('pi')` yields the pi variant, whose `piProvider` is
 * required, and callers need no fallback for a field this function guarantees.
 * Passing a non-literal `AgentTool` yields the whole union, which callers then
 * narrow on `entry.tool` as usual.
 */
export async function loadToolAuthEntry<T extends AgentTool>(
  tool: T,
): Promise<Extract<ToolAuthEntry, { tool: T }> | null> {
  // Each branch below builds the variant matching its own literal `tool`, but
  // that correspondence is beyond what TS infers across the branches, so the
  // result is asserted once here rather than at every return.
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
  /** Provider id for provider-scoped tools (opencode/pi) — required for them,
   *  and validated against that tool's registry: a missing or unrecognized id
   *  throws rather than storing a credential scoped to the wrong vendor.
   *  Ignored for claude/codex. */
  provider?: string,
): Promise<void> {
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
  if (tool === 'opencode') {
    // opencode supports api-key only. OAuth payloads are rejected at the
    // persistToolAuthPayload boundary; if we get here with kind='oauth',
    // store as api-key defensively so the proxy still has something to
    // inject.
    await saveOpencodeCredentialsFile({
      kind: 'api-key',
      provider: requireOpencodeProvider(provider),
      savedAt,
      apiKey,
    })
    return
  }
  if (tool === 'pi') {
    // pi is api-key only in yaac (OAuth rejected at persistToolAuthPayload);
    // store defensively as api-key so the proxy still has a key to inject.
    await savePiCredentialsFile({
      kind: 'api-key',
      provider: requirePiProvider(provider),
      savedAt,
      apiKey,
    })
    return
  }
  // Codex OAuth without a bundle can't be refreshed — callers should use
  // saveCodexOAuthBundle. Store as api-key so the proxy still injects
  // the token until the user re-runs `yaac auth update`.
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
 * Persist the result of a login flow into the HOST STORE. For Claude OAuth
 * this stores the full bundle (with refresh token + expiry) so the credential
 * can be refreshed later.
 *
 * The host store only — reaching every project's tool home is a separate step
 * (`fanOutToolCredentials` in `#domain/auth`) that this module cannot take,
 * because what belongs in a project home depends on whether the runtime
 * mediates egress: a sentinel where a proxy will swap it, the real bundle
 * where nothing would. That is a fact about the registered driver, which is
 * above this layer. Callers on the server side go through
 * `PUT /auth/:tool`, which does both in order.
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
  // Selected per tool rather than `piProvider ?? opencodeProvider`: collapsing
  // the two typed fields widens them back to a bare string, and ids like
  // `openrouter` exist in both registries — so a producer that filled the
  // wrong tool's field would pass validation against the wrong registry.
  const provider = tool === 'opencode' ? result.opencodeProvider
    : tool === 'pi' ? result.piProvider
    : undefined
  await saveToolAuth(tool, result.apiKey, result.kind, provider)
}

/**
 * Validate and persist a tool-auth payload the CLI sent after running
 * the native login flow locally. Throws `VALIDATION` for anything we
 * don't recognize.
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
      // An unrecognized provider is rejected here rather than coerced: this is
      // the wire boundary, so a typo'd or retired id should surface to the
      // caller instead of silently scoping the key to the default vendor.
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
  await writeCredentialsFileAtomic(
    projectClaudeCredentialsFile(slug),
    JSON.stringify(payload, null, 2) + '\n',
  )
}

/**
 * Write the REAL Claude OAuth bundle into a project's `.credentials.json`.
 *
 * The placeholder writer above exists because a worktree's egress is
 * mediated: the sentinel never leaves the pod, and the proxy swaps it for
 * this bundle on the way out. A runtime with no proxy has no such swap, so
 * the agent needs the real thing — and gets it, on disk, in a directory it
 * can read. That is the containerless bargain stated plainly (see
 * docs/containerless-driver.md): no sandbox, so no secret is held back
 * from what runs in it.
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
 * Whether a bundle is one of the sentinels a mediated runtime seeds rather
 * than a credential that could authenticate anything.
 *
 * Read before ever adopting a project-local bundle as the host's. Three
 * different situations produce one, and all three must be refused: a project
 * seeded for a proxied runtime, a data dir flipped from k8s to containerless
 * before anything re-seeded it, and a yaac-in-yaac install whose "real"
 * credentials ARE the outer proxy's sentinels by design (see
 * `buildFakeClaudeOAuthBundle`). Adopting one would overwrite a working host
 * credential with a string that authenticates nothing.
 *
 * The access token alone decides it. A placeholder bundle keeps real
 * non-secret fields (expiry, scopes, account id), so those say nothing about
 * whether the secret half is a sentinel.
 */
export function isPlaceholderClaudeBundle(bundle: ClaudeOAuthBundle): boolean {
  return bundle.accessToken === PLACEHOLDER_ACCESS_TOKEN
}

/** The Codex twin of `isPlaceholderClaudeBundle`. */
export function isPlaceholderCodexBundle(bundle: CodexOAuthBundle): boolean {
  return bundle.accessToken === PLACEHOLDER_ACCESS_TOKEN
}

/**
 * Read back the Claude credential a project's tool home currently holds —
 * whatever the agent that ran there last wrote.
 *
 * The counterpart to `writeProjectClaudeCredentials`, and the reason it
 * exists: under a runtime with no proxy the agent refreshes its own token,
 * so the project home (not the host store) is where the live credential
 * ends up. Reads claude's NATIVE shape, because claude wrote it.
 *
 * Two places one can be, and the Keychain wins. On macOS claude migrates the
 * credential into the item its `CLAUDE_CONFIG_DIR` names on first refresh and
 * deletes the file it came from, so a file still sitting there is by
 * definition the older of the two. Elsewhere the scoped read is a no-op and
 * the file is the only answer.
 *
 * Reports what is THERE, sentinels included — null means the project has no
 * parseable credential at all. Whether a sentinel counts as one is the
 * caller's question, not this reader's: harvesting must refuse it, while
 * deciding whether a project still needs seeding must be able to see it.
 */
export async function readProjectClaudeBundle(slug: string): Promise<ClaudeOAuthBundle | null> {
  const fromKeychain = readScopedClaudeKeychainPayload(claudeKeychainService(claudeDir(slug)))
  const raw = fromKeychain ?? await fs.readFile(projectClaudeCredentialsFile(slug), 'utf8').catch(() => null)
  if (raw === null) return null
  return extractClaudeOAuthBundle(raw)
}

/**
 * Read back the Codex credential a project's tool home currently holds — the
 * counterpart to `writeProjectCodexAuth`, for the same reason its Claude twin
 * above exists, and reporting sentinels the same way. File-only on every
 * platform: codex keeps no Keychain item.
 *
 * A file with no `last_refresh` reads as stamped at the epoch rather than at
 * now. `extractCodexOAuthBundle` synthesizes "now" for a missing stamp, which
 * is right where the answer describes a credential just captured from a login
 * — but here the stamp is a CLOCK that decides which of two credentials
 * supersedes the other, and a synthesized one would rank a stamp-less file
 * newest on every read and let it overwrite the live credential. Ranking it
 * oldest instead means it can never win, and therefore never propagates: the
 * epoch is only ever compared, never written back anywhere.
 *
 * Neither codex nor yaac's own writer omits the field, so this is a guard on
 * a shape neither produces rather than a case anything reaches today.
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
 * Every tracked project slug. A missing projects dir reads as none, matching
 * `forEachProject` — a server with no projects yet is not an error.
 */
export async function listCredentialProjectSlugs(): Promise<string[]> {
  try {
    return await fs.readdir(getProjectsDir())
  } catch {
    return []
  }
}

/**
 * Drop a project's scoped Claude Keychain item so the file becomes the
 * credential claude reads again.
 *
 * The write half of the macOS story, done by subtraction. Pushing a fresh
 * bundle into a project whose credential has migrated to the Keychain cannot
 * work by writing the file alone — claude prefers the item, so the new file
 * would be ignored. Rather than mint an item (whose account name is claude's
 * to choose, and a wrong guess leaves a duplicate claude ignores), remove the
 * stale one: with no item to prefer, claude reads the file that was just
 * written, and its next refresh migrates that back into a fresh item.
 *
 * Scoped-only by construction — `deleteScopedClaudeKeychainItem` refuses the
 * un-suffixed service, so this can never log the user's own claude install
 * out. A no-op off darwin and when no item exists.
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
 * After a successful Claude OAuth login, seed every existing project's
 * `.claude/.credentials.json` with a placeholder bundle. Fresh projects get
 * seeded on `project add`.
 */
export async function fanOutClaudePlaceholders(bundle: ClaudeOAuthBundle): Promise<void> {
  await forEachProject((slug) => writeProjectClaudePlaceholder(slug, bundle), 'failed to seed placeholder creds')
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
  await writeCredentialsFileAtomic(
    projectCodexAuthFile(slug),
    JSON.stringify(payload, null, 2) + '\n',
  )
}

/**
 * Write the REAL Codex `auth.json` into a project's codex dir — the
 * unmediated twin of `writeProjectCodexPlaceholder`, for a runtime with no
 * proxy to swap a sentinel (see `writeProjectClaudeCredentials`). Same
 * on-disk shape, real tokens.
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
 * After a successful Codex OAuth login, seed every existing project's
 * `codex/auth.json` with a placeholder bundle.
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
 * Remove every tracked project's claude credential — both places one can be.
 *
 * Used by `auth clear` (the CLI and the webapp's sign-out reach the same
 * door) to make sure running worktrees don't keep using a credential the
 * user has just revoked: a placeholder the proxy will no longer swap for a
 * real token, or — under a runtime with no proxy — the real bundle itself.
 *
 * The file is only half of it on macOS. A containerless worktree runs claude
 * with `CLAUDE_CONFIG_DIR` set to the project's claude dir, and claude
 * prefers the Keychain there: on its first token refresh it migrates the
 * credential into the item that dir names and deletes the file it came from.
 * So by the time anyone clears auth, the live token may exist ONLY in the
 * Keychain, and unlinking alone would leave a working credential behind
 * while reporting the account signed out. The item is per project because
 * the config dir is, and `deleteScopedClaudeKeychainItem` refuses the
 * un-suffixed service, so the user's own claude install is never touched.
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
