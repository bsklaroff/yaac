import { queryClaudePlanUsage, queryClaudeRateLimitTier, queryCodexPlanUsage } from './usage'
import { refreshClaudeOAuthBundle } from './claude-oauth'
import { refreshCodexOAuthBundle } from './codex-oauth'
import { getToolCredential, listToolCredentials } from '#db'
import { saveClaudeOAuthBundle, saveCodexOAuthBundle } from './store'
import {
  claudeBundleIsNewer,
  codexBundleIsNewer,
  harvestToolCredentials,
  hostMayRefreshCredentials,
  runtimeMediatesEgress,
} from './credential-sync'
import { pushCredentialsToRuntime } from './runtime-push'
import { notifyWorkspaceListChanged } from '#notify'
import { serverLog } from '#log'
import type { ClaudeOAuthBundle, CodexOAuthBundle, PlanUsageResult, ToolCredentialBundle } from '@yaac/shared/types'

/**
 * Subscription plan-usage readouts. The webapp never queries upstream: this
 * module refreshes each tool's usage endpoint on its own cadence, and
 * `buildSnapshot` reads the current values.
 *
 * One engine with per-user, per-tool state serves Claude and Codex; they
 * differ only in `claudeRefreshOnce` / `codexRefreshOnce`. Each user's
 * readout is of their own subscription.
 *
 * Upstream traffic happens only while a webapp client is connected:
 * snapshots are built only for connected clients, and `refreshPlanUsage` is
 * ticked only while the hub has a connection.
 */
const REFRESH_INTERVAL_MS = 5 * 60_000
/** Minimum interval for on-demand refreshes (popover opens), so re-opening
 *  the popover can't exhaust the endpoint's rate limit. */
const ON_DEMAND_MIN_INTERVAL_MS = 60_000
/** Keep showing the last good result across transient upstream trouble
 *  (429 throttles, blips) for this long before surfacing the failure. */
const STALE_GRACE_MS = 15 * 60_000

interface UsageState {
  current: PlanUsageResult | null
  /** When `current` last held a successful (available) result. */
  goodAt: number
  /** When the last upstream attempt started. Failures also wait out the
   *  interval, since the endpoint locks out after too many requests. */
  attemptAt: number
  inflight: boolean
  /** Claude only: the org's rate-limit tier (e.g. 'default_claude_max_20x'),
   *  fetched with the first usage refresh and kept for the credential's
   *  lifetime; null means fetch next cycle. Always null for Codex. */
  rateLimitTier: string | null
  /** Bumped by reset() so a refresh that was in flight across a credential
   *  change discards its result instead of resurfacing pre-change data. */
  generation: number
}

function freshState(): UsageState {
  return { current: null, goodAt: 0, attemptAt: 0, inflight: false, rateLimitTier: null, generation: 0 }
}

type UserStates = Record<'claude' | 'codex', UsageState>

/** Each user's engine state, by user id. */
const states = new Map<string, UserStates>()

function statesOf(owner: string): UserStates {
  let s = states.get(owner)
  if (!s) states.set(owner, s = { claude: freshState(), codex: freshState() })
  return s
}

/** Forget a tool's state on credential change (and between tests). */
function reset(state: UsageState): void {
  state.current = null
  state.goodAt = 0
  state.attemptAt = 0
  state.inflight = false
  state.rateLimitTier = null
  state.generation++
}

export function _resetPlanUsageForTests(): void {
  for (const s of states.values()) {
    reset(s.claude)
    reset(s.codex)
  }
  states.clear()
}

/**
 * Start a detached upstream refresh unless one is running or the last attempt
 * is within `minIntervalMs`. `runOnce` produces a result (including token
 * refresh and retries); this handles cadence, the generation guard, stale
 * grace and the snapshot notify.
 */
function kickRefresh(
  state: UsageState,
  minIntervalMs: number,
  runOnce: () => Promise<PlanUsageResult>,
): void {
  if (state.inflight || Date.now() - state.attemptAt < minIntervalMs) return
  state.inflight = true
  state.attemptAt = Date.now()
  const startedGeneration = state.generation
  void (async () => {
    const result = await runOnce()
    if (state.generation !== startedGeneration) return
    state.inflight = false
    if (result.available) {
      state.current = result
      state.goodAt = Date.now()
      // Cache Claude's tier once known (Codex results carry null).
      state.rateLimitTier = result.rateLimitTier ?? state.rateLimitTier
    } else {
      serverLog(`[server] plan-usage refresh failed: ${result.reason}${result.message ? ` (${result.message})` : ''}`)
      // Keep the last good result through transient failures, up to the
      // grace window.
      if (!(state.current?.available && Date.now() - state.goodAt < STALE_GRACE_MS)) {
        state.current = result
      }
    }
    // Notify now; the hub skips unchanged snapshots.
    notifyWorkspaceListChanged()
  })()
}

// ── Claude ─────────────────────────────────────────────────────────────

/**
 * Refresh Claude's OAuth bundle upstream and persist it, so workspaces and
 * later restarts use the new token. Never throws; null if the refresh
 * failed.
 */
async function refreshAndPersistClaudeBundle(
  owner: string,
  bundle: ClaudeOAuthBundle,
): Promise<ClaudeOAuthBundle | null> {
  const fresh = await refreshClaudeOAuthBundle(bundle)
  if (!fresh) return null
  try {
    // Another writer (a proxy-captured or harvested workspace refresh, `yaac
    // auth update`) may have replaced the credential meanwhile. Our grant
    // already spent the old token, so discarding `fresh` could leave a token
    // nothing can refresh. Newest wins: keep a genuinely newer stored bundle,
    // otherwise store ours.
    const stored = await getToolCredential(owner, 'claude')
    const current = stored?.kind === 'oauth' ? stored.claudeAiOauth : null
    if (!current
        || current.accessToken === bundle.accessToken
        || claudeBundleIsNewer(fresh, current)) {
      await saveClaudeOAuthBundle(owner, fresh)
      // The runtime's copy was just spent.
      await pushCredentialsToRuntime()
    }
  } catch (err) {
    // Only the save can throw. `fresh` still serves this cycle, and the next
    // refresh retries the save.
    serverLog(`[server] failed to persist refreshed Claude OAuth bundle: ${String(err)}`)
  }
  return fresh
}

/**
 * Adopt any token a running workspace refreshed, then return the stored
 * credential to use this cycle. Only needed without a proxy: with one, the
 * workspace holds a sentinel and its refreshes are already captured to the
 * owner's store, so `fallback` is current. Without one, this avoids querying
 * with (or refreshing) a superseded token. Never throws; returns `fallback`
 * on failure.
 */
async function convergedClaudeBundle(owner: string, fallback: ClaudeOAuthBundle): Promise<ClaudeOAuthBundle> {
  if (runtimeMediatesEgress()) return fallback
  try {
    await harvestToolCredentials(owner, { tool: 'claude' })
    const stored = await getToolCredential(owner, 'claude')
    if (stored?.kind === 'oauth') return stored.claudeAiOauth
  } catch (err) {
    serverLog(`[server] plan-usage: Claude credential harvest failed: ${String(err)}`)
  }
  return fallback
}

/** The Codex version of `convergedClaudeBundle`. */
async function convergedCodexBundle(owner: string, fallback: CodexOAuthBundle): Promise<CodexOAuthBundle> {
  if (runtimeMediatesEgress()) return fallback
  try {
    await harvestToolCredentials(owner, { tool: 'codex' })
    const stored = await getToolCredential(owner, 'codex')
    if (stored?.kind === 'oauth') return stored.codexOauth
  } catch (err) {
    serverLog(`[server] plan-usage: Codex credential harvest failed: ${String(err)}`)
  }
  return fallback
}

/** One Claude usage cycle: adopt workspace refreshes, refresh an expired
 *  token if this host may, query usage and (once per credential) the tier,
 *  and retry once after a refresh if an unexpired token is unauthorized. */
async function claudeRefreshOnce(owner: string, bundle: ClaudeOAuthBundle, state: UsageState): Promise<PlanUsageResult> {
  let effective = await convergedClaudeBundle(owner, bundle)
  let tokenRefreshTried = false
  // An expired token would only 401, so refresh first, but only if no live
  // workspace holds a copy we would invalidate (`hostMayRefreshCredentials`).
  // Otherwise a running agent refreshes and the harvest above picks it up.
  if (effective.expiresAt <= Date.now() && await hostMayRefreshCredentials()) {
    tokenRefreshTried = true
    effective = await refreshAndPersistClaudeBundle(owner, effective) ?? effective
  }
  let [result, tier] = await Promise.all([
    queryClaudePlanUsage(effective),
    state.rateLimitTier === null ? queryClaudeRateLimitTier(effective) : Promise.resolve(state.rateLimitTier),
  ])
  // Unauthorized despite an unexpired stamp (revoked, or stale expiresAt):
  // refresh and retry once, under the same gate as above.
  if (!result.available && result.reason === 'unauthorized' && !tokenRefreshTried
      && await hostMayRefreshCredentials()) {
    const fresh = await refreshAndPersistClaudeBundle(owner, effective)
    if (fresh) {
      ;[result, tier] = await Promise.all([
        queryClaudePlanUsage(fresh),
        tier === null ? queryClaudeRateLimitTier(fresh) : Promise.resolve(tier),
      ])
    }
  }
  return result.available ? { ...result, rateLimitTier: tier } : result
}

// ── Codex ──────────────────────────────────────────────────────────────

async function refreshAndPersistCodexBundle(
  owner: string,
  bundle: CodexOAuthBundle,
): Promise<CodexOAuthBundle | null> {
  const fresh = await refreshCodexOAuthBundle(bundle)
  if (!fresh) return null
  try {
    // Same newest-wins rule as for Claude; more important here, since Codex
    // refresh tokens are single-use.
    const stored = await getToolCredential(owner, 'codex')
    const current = stored?.kind === 'oauth' ? stored.codexOauth : null
    if (!current
        || current.accessToken === bundle.accessToken
        || codexBundleIsNewer(fresh, current)) {
      await saveCodexOAuthBundle(owner, fresh)
      await pushCredentialsToRuntime()
    }
  } catch (err) {
    serverLog(`[server] failed to persist refreshed Codex OAuth bundle: ${String(err)}`)
  }
  return fresh
}

/** One Codex usage cycle. Unlike Claude, it never refreshes proactively,
 *  because Codex refresh tokens are single-use and running workspaces keep
 *  the host token fresh. It refreshes only on an unauthorized result, and
 *  only if no live workspace holds the credential. */
async function codexRefreshOnce(owner: string, bundle: CodexOAuthBundle): Promise<PlanUsageResult> {
  const effective = await convergedCodexBundle(owner, bundle)
  let result = await queryCodexPlanUsage(effective)
  if (!result.available && result.reason === 'unauthorized' && await hostMayRefreshCredentials()) {
    const fresh = await refreshAndPersistCodexBundle(owner, effective)
    if (fresh) result = await queryCodexPlanUsage(fresh)
  }
  return result
}

// ── Snapshot slices ────────────────────────────────────────────────────

/**
 * One user's Claude readout. Checks the stored credential kind (so auth
 * changes show immediately), kicks a detached refresh at most once per
 * interval, and returns the cached result (null before the first refresh
 * lands).
 */
function claudeUsage(owner: string, creds: ToolCredentialBundle['claude']): PlanUsageResult | null {
  const state = statesOf(owner).claude
  if (!creds || creds.kind !== 'oauth') {
    reset(state)
    return creds
      ? { available: false, reason: 'api-key' }
      : { available: false, reason: 'no-credentials' }
  }
  const bundle = creds.claudeAiOauth
  kickRefresh(state, REFRESH_INTERVAL_MS, () => claudeRefreshOnce(owner, bundle, state))
  return state.current
}

/**
 * One user's Codex readout. Only ChatGPT (OAuth) auth is queryable;
 * otherwise null, and the readout omits Codex.
 */
function codexUsage(owner: string, creds: ToolCredentialBundle['codex']): PlanUsageResult | null {
  const state = statesOf(owner).codex
  if (!creds || creds.kind !== 'oauth') {
    reset(state)
    return null
  }
  const bundle = creds.codexOauth
  kickRefresh(state, REFRESH_INTERVAL_MS, () => codexRefreshOnce(owner, bundle))
  return state.current
}

/**
 * The plan-usage slices of the snapshot, by user id, for every user with a
 * stored tool credential. A user with none is absent.
 */
export async function planUsageForSnapshot(): Promise<{
  planUsage: Record<string, PlanUsageResult | null>
  codexPlanUsage: Record<string, PlanUsageResult | null>
}> {
  const planUsage: Record<string, PlanUsageResult | null> = {}
  const codexPlanUsage: Record<string, PlanUsageResult | null> = {}
  for (const [owner, bundle] of Object.entries(await listToolCredentials())) {
    planUsage[owner] = claudeUsage(owner, bundle.claude)
    codexPlanUsage[owner] = codexUsage(owner, bundle.codex)
  }
  return { planUsage, codexPlanUsage }
}

/**
 * On-demand refresh when a user opens the webapp's usage popover, so their
 * numbers are at most a minute old. Covers each of their signed-in tools;
 * results arrive in the next snapshot.
 */
export async function requestPlanUsageRefresh(owner: string): Promise<void> {
  kickSignedInTools(owner, {
    claude: await getToolCredential(owner, 'claude'),
    codex: await getToolCredential(owner, 'codex'),
  }, ON_DEMAND_MIN_INTERVAL_MS)
}

/**
 * The background refresh of every user's readouts, on the server's own
 * interval (see server-run). The upstream endpoints have no push, so this
 * must poll. The caller runs it only while a client is connected, so a
 * closed webapp causes no upstream traffic.
 */
export async function refreshPlanUsage(): Promise<void> {
  for (const [owner, bundle] of Object.entries(await listToolCredentials())) {
    kickSignedInTools(owner, bundle, REFRESH_INTERVAL_MS)
  }
}

/** Kick each of a user's signed-in tools' engines, subject to
 *  `minIntervalMs`. */
function kickSignedInTools(
  owner: string,
  { claude, codex }: Pick<ToolCredentialBundle, 'claude' | 'codex'>,
  minIntervalMs: number,
): void {
  const s = statesOf(owner)
  if (claude?.kind === 'oauth') {
    const bundle = claude.claudeAiOauth
    kickRefresh(s.claude, minIntervalMs, () => claudeRefreshOnce(owner, bundle, s.claude))
  }
  if (codex?.kind === 'oauth') {
    const bundle = codex.codexOauth
    kickRefresh(s.codex, minIntervalMs, () => codexRefreshOnce(owner, bundle))
  }
}
