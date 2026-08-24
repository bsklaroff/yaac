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
import { hasWorktreeDriver, worktreeDriver } from '#drivers/driver'
import { serverLog } from '#log'
import type { AgentTool, ClaudeOAuthBundle, CodexOAuthBundle } from '@yaac/shared/types'

/**
 * Convergence between the two places an OAuth credential can live: the host
 * store (`~/.yaac/.credentials/*.json`) and each project's tool home
 * (`~/.yaac/projects/<slug>/{claude,codex}`), which is what an agent reads.
 *
 * Under a runtime that mediates egress the two never disagree, because the
 * project home holds a sentinel and every refresh an agent drives transits
 * the proxy, which writes the host store itself. Without a proxy the agent
 * holds the real credential and refreshes it in place, so the project home
 * becomes where the live token is and the host store goes stale — and a
 * stale host store is not merely out of date. OAuth refresh tokens rotate:
 * spending a superseded one fails, and for Codex (single-use, stated in
 * `codex-oauth`) it can strand the chain entirely.
 *
 * So one rule, in one place: **the newest credential wins, and both sides
 * converge on it.** Harvest carries a project's refreshed bundle up to the
 * host store; push carries the host store's back down to projects that are
 * behind. Seeding a project is those two in order, which is what makes it
 * safe to run on every worktree create — the write can only ever move a
 * project forward.
 *
 * Placeholders never participate. The readers report a sentinel rather than
 * hiding it — seeding has to be able to tell a project holding one from a
 * project holding nothing — and every decision here refuses it: it is never
 * adopted as the host's credential, and never counts as a project being "up
 * to date". That is what lets these functions run under either driver: under
 * a mediated one every project reads as having nothing to harvest, and the
 * fan-out below writes sentinels rather than the real bundle.
 */

/**
 * Whether this process's runtime intercepts workspace egress — the one fact
 * that decides whether a project's tool home should hold a sentinel or the
 * real credential.
 *
 * Defaults to `true` with no driver registered, which is the conservative
 * answer rather than the common one: an entrypoint that composes no driver
 * (the api tests build the Hono app in-process) must not be the reason a real
 * bundle gets written to disk somewhere nothing would swap it back out.
 */
export function runtimeMediatesEgress(): boolean {
  return !hasWorktreeDriver() || worktreeDriver().kind !== 'containerless'
}

/**
 * Whether any workspace is live right now.
 *
 * Gates the host's own token refresh. A refresh rotates the credential, and
 * under an unmediated runtime the live agent holds its own copy of it — so
 * refreshing behind its back invalidates what it is using, which is the
 * mirror image of the staleness this module exists to fix. When something is
 * live we harvest and use whatever it produced instead; the agent refreshes
 * on its own schedule and that refresh is the one that counts.
 */
async function anyLiveWorkspace(): Promise<boolean> {
  if (!hasWorktreeDriver()) return false
  const handles = await worktreeDriver().snapshot().workspaces()
  return handles.some((h) => h.running && !h.terminating)
}

/**
 * Whether the host may refresh a rotating credential itself.
 *
 * Only ever false under an unmediated runtime with something running. With a
 * proxy the pod never holds the real token, so a host refresh races nothing;
 * with nothing running there is no other holder to invalidate. A failure to
 * answer reads as "something might be live", because the cost of guessing
 * wrong that way is a delayed usage readout, and the other way is logging a
 * running agent out.
 *
 * The answer is a point-in-time read, and the accepted residual is the window
 * after it: a create that seeds and launches an agent while a refresh this
 * gate allowed is still in flight hands that agent the token the host is
 * spending, and if the host wins, the agent's first refresh gets
 * invalid_grant. It needs an already-expired host credential and a create
 * inside roughly one round trip, and it self-heals — claude re-reads its
 * store on a 401 and adopts an externally written token, and the next sweep
 * pushes the host's out regardless. Closing it properly means counting
 * creates-in-flight as live, which is a fact `#domain/worktrees` holds and
 * this module cannot reach: create already depends on `#domain/auth` for
 * seeding, so reading the provisioning registry from here would make that
 * cycle. It would take moving the liveness source into what composes both.
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
 * Whether `candidate` supersedes `current`.
 *
 * An identical access token is the same credential however it got here, so it
 * never wins — that is what keeps a repeated sweep from rewriting files. Past
 * that, a refresh always yields a later expiry, so the expiry is the clock.
 */
export function claudeBundleIsNewer(candidate: ClaudeOAuthBundle, current: ClaudeOAuthBundle): boolean {
  if (candidate.accessToken === current.accessToken) return false
  return candidate.expiresAt > current.expiresAt
}

/**
 * The Codex twin. `lastRefresh` is what codex stamps on every refresh, so it
 * is the truer clock; expiry (decoded from the access token's own JWT) breaks
 * ties and covers an unparseable stamp.
 *
 * The stamp is only a clock if it came off disk. `readProjectCodexBundle`
 * is what guarantees that here — it ranks a file carrying no `last_refresh`
 * at the epoch rather than letting the extractor's "now" stand in, because a
 * synthesized stamp would make such a file the newest thing on every read.
 * The differing-access-token gate above it is about churn, not about that: it
 * stops a sweep rewriting the same credential, and would not stop a genuinely
 * different one from being adopted on a made-up timestamp.
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
 * Adopt the newest Claude bundle among `slugs` into the host store.
 *
 * The compare-and-set mirrors the plan-usage refresher's, and for the same
 * reason: reading the projects takes long enough that another writer (a
 * proxy-captured refresh, an `auth update`, the poller) may have replaced the
 * stored credential meanwhile, and that writer's is at least as fresh as what
 * we started from. Losing the race costs nothing — the next sweep re-reads.
 */
async function harvestClaude(slugs: string[]): Promise<void> {
  const stored = await loadClaudeCredentialsFile()
  // api-key auth has no refresh to harvest, and no credential at all means
  // the user is signed out — a project file left behind must not sign them
  // back in.
  if (stored?.kind !== 'oauth') return
  const base = stored.claudeAiOauth
  let best = base
  for (const slug of slugs) {
    const candidate = await readProjectClaudeBundle(slug).catch(() => null)
    // A sentinel is not a credential to adopt — `isPlaceholderClaudeBundle`
    // lists the three ways a project comes to hold one.
    if (!candidate || isPlaceholderClaudeBundle(candidate)) continue
    if (claudeBundleIsNewer(candidate, best)) best = candidate
  }
  if (best === base) return
  const now = await loadClaudeCredentialsFile()
  if (now?.kind === 'oauth' && now.claudeAiOauth.accessToken === base.accessToken) {
    await saveClaudeOAuthBundle(best)
    serverLog('[server] credential-sync: adopted a refreshed Claude bundle from a worktree')
  }
}

/** The Codex twin of `harvestClaude`. */
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
    serverLog('[server] credential-sync: adopted a refreshed Codex bundle from a worktree')
  }
}

/**
 * Pull any credential a worktree has refreshed up into the host store.
 *
 * Cheap enough to call wherever staleness would bite — a couple of file reads
 * per project — which is why there is no watcher: the call sites (before a
 * host refresh, before seeding a create, on attach, on stop, and the resync
 * cadence) cover every reader of the host store.
 *
 * `tool` narrows the sweep to the one whose credential the caller is about to
 * use. It exists because the plan-usage engine runs a cycle per tool: sweeping
 * both on each would read every project twice per tick, and on macOS a Claude
 * read spawns `security`, so the halving is a subprocess per project rather
 * than a few file reads. `slug` narrows it to one project, for a caller that
 * knows which one just changed.
 *
 * Best-effort by construction. A project that cannot be read is skipped
 * rather than failing the sweep, because the whole point is to improve on a
 * stale credential, and improving on some beats improving on none.
 */
export async function harvestToolCredentials(
  opts: { tool?: 'claude' | 'codex'; slug?: string } = {},
): Promise<void> {
  const slugs = opts.slug !== undefined ? [opts.slug] : await listCredentialProjectSlugs()
  if (slugs.length === 0) return
  if (opts.tool !== 'codex') await harvestClaude(slugs)
  if (opts.tool !== 'claude') await harvestCodex(slugs)
}

// ── Push: host store → project tool homes ──────────────────────────────

/**
 * Write the host's Claude bundle into a project that is behind it.
 *
 * The repair for cross-project divergence: each project holds its own copy,
 * so one project's agent rotating the shared refresh token leaves every other
 * project holding a superseded one, whose next refresh fails. Harvest makes
 * the host store track whichever project won; this hands that back to the
 * ones that lost, so they heal without waiting for a create.
 *
 * `force` is user intent — a fresh login, which may be a different account
 * entirely, so newest-wins must not veto it.
 *
 * The Keychain item goes after the file, and only once the file is written.
 * On macOS claude prefers the item, so the new file would be ignored while a
 * stale one survives; dropping it leaves the file as the only credential
 * there, which claude reads and re-migrates on its next refresh. Ordered this
 * way so a failed write can never leave the project with neither.
 */
async function pushClaude(slug: string, force: boolean): Promise<void> {
  const stored = await loadClaudeCredentialsFile()
  if (stored?.kind !== 'oauth') return
  const host = stored.claudeAiOauth
  if (!force) {
    const current = await readProjectClaudeBundle(slug).catch(() => null)
    // Same token however each got here: nothing to do, and this is what keeps
    // a repeating sweep from rewriting every project's file forever. It is
    // also the whole of the yaac-in-yaac case, where host and project are
    // legitimately the same sentinel.
    if (current && current.accessToken === host.accessToken) return
    // A project holding a real credential may only be replaced by a strictly
    // newer real one. Never by a sentinel — under a chained install the host
    // store holds one, and stamping it over a working credential would break
    // the very worktrees this is meant to heal. A project holding a sentinel
    // (or nothing) has nothing to lose and takes whatever the host has.
    if (current && !isPlaceholderClaudeBundle(current)
        && (isPlaceholderClaudeBundle(host) || !claudeBundleIsNewer(host, current))) return
  }
  await writeProjectClaudeCredentials(slug, host)
  dropProjectClaudeKeychainItem(slug)
}

/** The Codex twin of `pushClaude`. No Keychain half — codex keeps no item. */
async function pushCodex(slug: string, force: boolean): Promise<void> {
  const stored = await loadCodexCredentialsFile()
  if (stored?.kind !== 'oauth') return
  const host = stored.codexOauth
  if (!force) {
    const current = await readProjectCodexBundle(slug).catch(() => null)
    if (current && current.accessToken === host.accessToken) return
    if (current && !isPlaceholderCodexBundle(current)
        && (isPlaceholderCodexBundle(host) || !codexBundleIsNewer(host, current))) return
  }
  await writeProjectCodexAuth(slug, host)
}

// ── The composed operations ────────────────────────────────────────────

/**
 * Bring one project's tool homes to what a worktree there should launch with.
 *
 * Called on every create, and the two halves are why it is safe to: harvest
 * first, so anything a running worktree in this project has refreshed becomes
 * the host's; then push, which by then can only write something at least as
 * new as what is already there. The create-time write that used to overwrite
 * a live credential with a stale host copy is exactly the case this removes.
 *
 * Under a mediated runtime it stays what it always was — an unconditional
 * sentinel write, cheap and idempotent, with no credential to preserve.
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
  await pushClaude(slug, false)
  await pushCodex(slug, false)
}

/**
 * Converge every project both ways: adopt the newest credential anywhere,
 * then heal the projects that are behind it.
 *
 * The standing sweep — driven by the reconcile resync, the containerless
 * attach, and worktree stop. Under a mediated runtime the push half is a
 * no-op (project homes hold sentinels, which never read as a credential) and
 * the harvest half finds nothing, so it costs a few reads and changes
 * nothing; the fan-out below is what keeps sentinels current there.
 */
async function syncToolCredentials(): Promise<void> {
  const slugs = await listCredentialProjectSlugs()
  if (slugs.length === 0) return
  await harvestClaude(slugs)
  await harvestCodex(slugs)
  if (runtimeMediatesEgress()) return
  for (const slug of slugs) {
    try {
      await pushClaude(slug, false)
      await pushCodex(slug, false)
    } catch (err) {
      serverLog(`[server] credential-sync: push to project "${slug}" failed: ${String(err)}`)
    }
  }
}

/** How often the standing sweep may actually run. */
const SYNC_MIN_INTERVAL_MS = 5 * 60_000
let lastSyncAt = 0

/** Test-only: forget the throttle so cases don't inherit each other's clock. */
export function _resetCredentialSyncThrottleForTests(): void {
  lastSyncAt = 0
}

/**
 * `syncToolCredentials` on a leash, for the reconcile pass.
 *
 * The pass resyncs every 60s and this step has no edge to wait for, so
 * without a floor it would sweep every project a minute — and on macOS
 * reading a project's Claude credential means spawning `security`, so that
 * is a subprocess per project per minute to notice a change that has hours
 * of slack in it. Five minutes matches the plan-usage cadence, which is the
 * other reader that would have found the same drift anyway.
 */
export async function syncToolCredentialsThrottled(): Promise<void> {
  if (Date.now() - lastSyncAt < SYNC_MIN_INTERVAL_MS) return
  lastSyncAt = Date.now()
  await syncToolCredentials()
}

/**
 * Seed a just-captured login into every project.
 *
 * The driver-aware replacement for the placeholder fan-out that used to sit
 * inside the shared persistence call: a sentinel where a proxy will swap it,
 * the real bundle where nothing would. Forced, because a login is the user
 * saying which account this install uses — possibly a different one — so it
 * must supersede whatever any project currently holds rather than losing a
 * newest-wins comparison to the account being replaced.
 *
 * Per-project failures are warned and skipped: a login that reached the host
 * store has succeeded at the part that cannot be redone, and every project it
 * missed is repaired by the next sweep or create.
 *
 * Writes the bundle straight out rather than going through `push`. Forcing
 * past the comparison is the whole intent here, and `push` would re-read the
 * host store per project to reach a comparison it then skips — so this reads
 * it once, which is all a fan-out of one just-persisted credential needs.
 * The Keychain drop stays, for the reason `dropProjectClaudeKeychainItem`
 * gives: on macOS a stale item would otherwise outrank the file just written.
 */
export async function fanOutToolCredentials(
  tool: AgentTool,
  opts: { mediatedEgress: boolean },
): Promise<void> {
  // opencode and pi authenticate by env var and keep no project file at all,
  // so there is nothing to fan out for them.
  if (tool !== 'claude' && tool !== 'codex') return
  const slugs = await listCredentialProjectSlugs()
  if (slugs.length === 0) return

  // An api-key (or absent) credential has no bundle to seed — the key travels
  // as an env var instead.
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
