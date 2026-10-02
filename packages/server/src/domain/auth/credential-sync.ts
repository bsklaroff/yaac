import {
  dropProjectClaudeKeychainItem,
  isPlaceholderClaudeBundle,
  isPlaceholderCodexBundle,
  listCredentialProjectSlugs,
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
  readProjectClaudeBundle,
  readProjectCodexBundle,
  saveClaudeOAuthBundle,
  saveCodexOAuthBundle,
  writeProjectClaudeCredentials,
  writeProjectClaudePlaceholder,
  writeProjectCodexAuth,
  writeProjectCodexPlaceholder,
} from '@yaac/shared/tool-auth'
import { hasWorkspaceDriver, workspaceDriver } from '#drivers/driver'
import { serverLog } from '#log'
import type { AgentTool, ClaudeOAuthBundle, CodexOAuthBundle } from '@yaac/shared/types'

/**
 * Keeps OAuth credentials consistent between the host store
 * (`~/.yaac/.credentials/*.json`) and each project's tool home
 * (`~/.yaac/projects/<slug>/{claude,codex}`), which agents read.
 *
 * With mediated egress (k8s) the project home holds a sentinel and the proxy
 * writes every refresh to the host store, so they never disagree. Without a
 * proxy (containerless) the agent refreshes the real credential in place and
 * the host store goes stale. Refresh tokens rotate, so spending a superseded
 * one fails (and for Codex's single-use tokens can break the chain).
 *
 * Rule: the newest credential wins and both sides converge on it. Harvest
 * copies a newer project bundle up to the host store; push copies the host's
 * down to projects that are behind. Seeding does both, so running it on every
 * create can only move a project forward.
 *
 * Placeholders are never adopted and never count as up to date.
 *
 * With mediated egress nothing is harvested: the proxy is the only refresh
 * writer (docs/workspace-egress.md), and a sandboxed pod could otherwise plant
 * a bundle that switches the account for the whole install.
 */

/**
 * Whether the runtime intercepts workspace egress, which decides whether a
 * project's tool home gets a sentinel or the real credential. True when no
 * driver is registered (e.g. api tests), the safe default that never writes a
 * real bundle.
 */
export function runtimeMediatesEgress(): boolean {
  return !hasWorkspaceDriver() || workspaceDriver().kind !== 'containerless'
}

/** Whether any workspace is live right now. */
async function anyLiveWorkspace(): Promise<boolean> {
  if (!hasWorkspaceDriver()) return false
  const handles = await workspaceDriver().snapshot().workspaces()
  return handles.some((h) => h.running && !h.terminating)
}

/**
 * Whether the host may refresh a rotating credential itself. False only
 * without a proxy while a workspace is live, since a host refresh would
 * invalidate the agent's copy; the agent refreshes and harvest picks it up.
 * An error counts as "maybe live" (a delayed readout beats logging an agent
 * out).
 *
 * Known gap: a create that launches an agent while an allowed refresh is in
 * flight may hand it the token being spent. This needs an expired host token
 * and tight timing, and self-heals (claude re-reads its store on a 401; the
 * next sweep pushes). Closing it would mean counting in-flight creates as
 * live, which `#domain/workspaces` knows but this module can't import
 * without a cycle.
 */
export async function hostMayRefreshCredentials(): Promise<boolean> {
  if (runtimeMediatesEgress()) return true
  try {
    return !(await anyLiveWorkspace())
  } catch (err) {
    serverLog(`[server] credential-sync: liveness check failed, holding off refresh: ${String(err)}`)
    return false
  }
}

// ── Comparators ────────────────────────────────────────────────────────

/**
 * Whether `candidate` supersedes `current`. An identical access token never
 * wins (so repeated sweeps don't rewrite files); otherwise the later expiry
 * wins.
 */
export function claudeBundleIsNewer(candidate: ClaudeOAuthBundle, current: ClaudeOAuthBundle): boolean {
  if (candidate.accessToken === current.accessToken) return false
  return candidate.expiresAt > current.expiresAt
}

/**
 * The Codex version. Compares `lastRefresh` (stamped by codex on every
 * refresh) first, then expiry (from the access token's JWT) for ties or an
 * unparseable stamp. `readProjectCodexBundle` ranks a file without
 * `last_refresh` at the epoch, so a missing stamp never looks newest.
 */
export function codexBundleIsNewer(candidate: CodexOAuthBundle, current: CodexOAuthBundle): boolean {
  if (candidate.accessToken === current.accessToken) return false
  const a = Date.parse(candidate.lastRefresh)
  const b = Date.parse(current.lastRefresh)
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b
  return candidate.expiresAt > current.expiresAt
}

// ── Harvest: project tool homes → host store ───────────────────────────

/**
 * Adopt the newest Claude bundle among `slugs` into the host store. A
 * compare-and-set skips the write if another writer changed the store while
 * the projects were read; the next sweep re-reads.
 */
async function harvestClaude(slugs: string[]): Promise<void> {
  const stored = await loadClaudeCredentialsFile()
  // Nothing to harvest for api-key auth, and a leftover project file must
  // not sign a signed-out user back in.
  if (stored?.kind !== 'oauth') return
  const base = stored.claudeAiOauth
  let best = base
  for (const slug of slugs) {
    const candidate = await readProjectClaudeBundle(slug).catch(() => null)
    // Never adopt a sentinel (see `isPlaceholderClaudeBundle`).
    if (!candidate || isPlaceholderClaudeBundle(candidate)) continue
    if (claudeBundleIsNewer(candidate, best)) best = candidate
  }
  if (best === base) return
  const now = await loadClaudeCredentialsFile()
  if (now?.kind === 'oauth' && now.claudeAiOauth.accessToken === base.accessToken) {
    await saveClaudeOAuthBundle(best)
    serverLog('[server] credential-sync: adopted a refreshed Claude bundle from a workspace')
  }
}

/** The Codex version of `harvestClaude`. */
async function harvestCodex(slugs: string[]): Promise<void> {
  const stored = await loadCodexCredentialsFile()
  if (stored?.kind !== 'oauth') return
  const base = stored.codexOauth
  let best = base
  for (const slug of slugs) {
    const candidate = await readProjectCodexBundle(slug).catch(() => null)
    if (!candidate || isPlaceholderCodexBundle(candidate)) continue
    if (codexBundleIsNewer(candidate, best)) best = candidate
  }
  if (best === base) return
  const now = await loadCodexCredentialsFile()
  if (now?.kind === 'oauth' && now.codexOauth.accessToken === base.accessToken) {
    await saveCodexOAuthBundle(best)
    serverLog('[server] credential-sync: adopted a refreshed Codex bundle from a workspace')
  }
}

/**
 * Copy any credential a workspace refreshed up into the host store. Cheap (a
 * few file reads per project), so it is called wherever staleness matters
 * (before a host refresh, before seeding a create, on attach, on stop, on
 * resync) instead of using a watcher.
 *
 * `tool` limits the sweep to one tool (plan usage runs per tool, and on macOS
 * each Claude read spawns `security`); `slug` limits it to one project.
 * Unreadable projects are skipped.
 */
export async function harvestToolCredentials(
  opts: { tool?: 'claude' | 'codex'; slug?: string } = {},
): Promise<void> {
  if (runtimeMediatesEgress()) return
  const slugs = opts.slug !== undefined ? [opts.slug] : await listCredentialProjectSlugs()
  if (slugs.length === 0) return
  if (opts.tool !== 'codex') await harvestClaude(slugs)
  if (opts.tool !== 'claude') await harvestCodex(slugs)
}

// ── Push: host store → project tool homes ──────────────────────────────

/**
 * Write the host's Claude bundle into a project that is behind it. When one
 * project's agent rotates the shared refresh token, the others hold a
 * superseded one; harvest updates the host store and this copies it back
 * out.
 *
 * The macOS Keychain item is dropped only after the file is written: claude
 * prefers the item, so a stale one would shadow the new file, and dropping
 * it first could leave the project with neither.
 */
async function pushClaude(slug: string): Promise<void> {
  const stored = await loadClaudeCredentialsFile()
  if (stored?.kind !== 'oauth') return
  const host = stored.claudeAiOauth
  const current = await readProjectClaudeBundle(slug).catch(() => null)
  // Same token: nothing to do. This also covers yaac-in-yaac, where both
  // hold the same sentinel.
  if (current && current.accessToken === host.accessToken) return
  // A real project credential is replaced only by a strictly newer real
  // one, never by a sentinel (which a chained install's host store holds).
  // A project with a sentinel or nothing takes whatever the host has.
  if (current && !isPlaceholderClaudeBundle(current)
      && (isPlaceholderClaudeBundle(host) || !claudeBundleIsNewer(host, current))) return
  await writeProjectClaudeCredentials(slug, host)
  dropProjectClaudeKeychainItem(slug)
}

/** The Codex version of `pushClaude` (codex uses no Keychain item). */
async function pushCodex(slug: string): Promise<void> {
  const stored = await loadCodexCredentialsFile()
  if (stored?.kind !== 'oauth') return
  const host = stored.codexOauth
  const current = await readProjectCodexBundle(slug).catch(() => null)
  if (current && current.accessToken === host.accessToken) return
  if (current && !isPlaceholderCodexBundle(current)
      && (isPlaceholderCodexBundle(host) || !codexBundleIsNewer(host, current))) return
  await writeProjectCodexAuth(slug, host)
}

// ── The composed operations ────────────────────────────────────────────

/**
 * Prepare a project's tool homes for a workspace launch; called on every
 * create. Without a proxy it harvests first (so a running workspace's refresh
 * reaches the host store), then pushes, so it never overwrites a newer
 * credential. With a proxy it just writes sentinels.
 */
export async function seedProjectToolHome(
  slug: string,
  opts: { mediatedEgress: boolean },
): Promise<void> {
  if (opts.mediatedEgress) {
    const claude = await loadClaudeCredentialsFile()
    if (claude?.kind === 'oauth') await writeProjectClaudePlaceholder(slug, claude.claudeAiOauth)
    const codex = await loadCodexCredentialsFile()
    if (codex?.kind === 'oauth') await writeProjectCodexPlaceholder(slug, codex.codexOauth)
    return
  }
  await harvestToolCredentials({ slug })
  await pushClaude(slug)
  await pushCodex(slug)
}

/**
 * Converge every project both ways: adopt the newest credential anywhere,
 * then update projects that are behind. Run by a timed reconcile step,
 * whose first run is at attach. A no-op with a proxy, where project homes
 * hold sentinels kept current by `fanOutToolCredentials`.
 */
export async function syncToolCredentials(): Promise<void> {
  if (runtimeMediatesEgress()) return
  const slugs = await listCredentialProjectSlugs()
  if (slugs.length === 0) return
  await harvestClaude(slugs)
  await harvestCodex(slugs)
  for (const slug of slugs) {
    try {
      await pushClaude(slug)
      await pushCodex(slug)
    } catch (err) {
      serverLog(`[server] credential-sync: push to project "${slug}" failed: ${String(err)}`)
    }
  }
}

/**
 * Write a new login into every project: a sentinel with a proxy, the real
 * bundle without. Unconditional, since a login may switch accounts and must
 * not lose a newest-wins comparison. Per-project failures are logged and
 * skipped; the next sweep or create repairs them. As in `pushClaude`, the
 * macOS Keychain item is dropped after writing the file.
 */
export async function fanOutToolCredentials(
  tool: AgentTool,
  opts: { mediatedEgress: boolean },
): Promise<void> {
  // opencode and pi authenticate by env var and keep no project file.
  if (tool !== 'claude' && tool !== 'codex') return
  const slugs = await listCredentialProjectSlugs()
  if (slugs.length === 0) return

  // api-key auth has no bundle; the key is passed as an env var.
  const stored = tool === 'claude' ? await loadClaudeCredentialsFile() : await loadCodexCredentialsFile()
  if (stored?.kind !== 'oauth') return

  for (const slug of slugs) {
    try {
      if ('claudeAiOauth' in stored) {
        if (opts.mediatedEgress) {
          await writeProjectClaudePlaceholder(slug, stored.claudeAiOauth)
        } else {
          await writeProjectClaudeCredentials(slug, stored.claudeAiOauth)
          dropProjectClaudeKeychainItem(slug)
        }
      } else if (opts.mediatedEgress) {
        await writeProjectCodexPlaceholder(slug, stored.codexOauth)
      } else {
        await writeProjectCodexAuth(slug, stored.codexOauth)
      }
    } catch (err) {
      serverLog(`[server] credential-sync: ${tool} fan-out to project "${slug}" failed: ${String(err)}`)
    }
  }
}
