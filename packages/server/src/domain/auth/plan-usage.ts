import { queryClaudePlanUsage, queryClaudeRateLimitTier, queryCodexPlanUsage } from './usage'
import { refreshClaudeOAuthBundle } from './claude-oauth'
import { refreshCodexOAuthBundle } from './codex-oauth'
import {
  loadClaudeCredentialsFile,
  saveClaudeOAuthBundle,
  loadCodexCredentialsFile,
  saveCodexOAuthBundle,
} from '@yaac/shared/tool-auth'
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
import type { ClaudeOAuthBundle, CodexOAuthBundle, PlanUsageResult } from '@yaac/shared/types'

/**
 * Subscription plan-usage readouts. The webapp never queries upstream: this
 * module refreshes each tool's usage endpoint on its own cadence, and
 * `buildSnapshot` reads the current values.
 *
 * One engine with per-tool state serves Claude and Codex; they differ only in
 * `claudeRefreshOnce` / `codexRefreshOnce`.
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

const states: Record<'claude' | 'codex', UsageState> = {
  claude: freshState(),
  codex: freshState(),
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
  reset(states.claude)
  reset(states.codex)
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
    const stored = await loadClaudeCredentialsFile()
    const current = stored?.kind === 'oauth' ? stored.claudeAiOauth : null
    if (!current
        || current.accessToken === bundle.accessToken
        || claudeBundleIsNewer(fresh, current)) {
      await saveClaudeOAuthBundle(fresh)
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
 * host store, so `fallback` is current. Without one, this avoids querying
 * with (or refreshing) a superseded token. Never throws; returns `fallback`
 * on failure.
 */
async function convergedClaudeBundle(fallback: ClaudeOAuthBundle): Promise<ClaudeOAuthBundle> {
  if (runtimeMediatesEgress()) return fallback
  try {
    await harvestToolCredentials({ tool: 'claude' })
    const stored = await loadClaudeCredentialsFile()
    if (stored?.kind === 'oauth') return stored.claudeAiOauth
  } catch (err) {
    serverLog(`[server] plan-usage: Claude credential harvest failed: ${String(err)}`)
  }
  return fallback
}

/** The Codex version of `convergedClaudeBundle`. */
async function convergedCodexBundle(fallback: CodexOAuthBundle): Promise<CodexOAuthBundle> {
  if (runtimeMediatesEgress()) return fallback
  try {
    await harvestToolCredentials({ tool: 'codex' })
    const stored = await loadCodexCredentialsFile()
    if (stored?.kind === 'oauth') return stored.codexOauth
  } catch (err) {
    serverLog(`[server] plan-usage: Codex credential harvest failed: ${String(err)}`)
  }
  return fallback
}

/** One Claude usage cycle: adopt workspace refreshes, refresh an expired
 *  token if this host may, query usage and (once per credential) the tier,
 *  and retry once after a refresh if an unexpired token is unauthorized. */
async function claudeRefreshOnce(bundle: ClaudeOAuthBundle, state: UsageState): Promise<PlanUsageResult> {
  let effective = await convergedClaudeBundle(bundle)
  let tokenRefreshTried = false
  // An expired token would only 401, so refresh first, but only if no live
  // workspace holds a copy we would invalidate (`hostMayRefreshCredentials`).
  // Otherwise a running agent refreshes and the harvest above picks it up.
  if (effective.expiresAt <= Date.now() && await hostMayRefreshCredentials()) {
    tokenRefreshTried = true
    effective = await refreshAndPersistClaudeBundle(effective) ?? effective
  }
  let [result, tier] = await Promise.all([
    queryClaudePlanUsage(effective),
    state.rateLimitTier === null ? queryClaudeRateLimitTier(effective) : Promise.resolve(state.rateLimitTier),
  ])
  // Unauthorized despite an unexpired stamp (revoked, or stale expiresAt):
  // refresh and retry once, under the same gate as above.
  if (!result.available && result.reason === 'unauthorized' && !tokenRefreshTried
      && await hostMayRefreshCredentials()) {
    const fresh = await refreshAndPersistClaudeBundle(effective)
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
  bundle: CodexOAuthBundle,
): Promise<CodexOAuthBundle | null> {
  const fresh = await refreshCodexOAuthBundle(bundle)
  if (!fresh) return null
  try {
    // Same newest-wins rule as for Claude; more important here, since Codex
    // refresh tokens are single-use.
    const stored = await loadCodexCredentialsFile()
    const current = stored?.kind === 'oauth' ? stored.codexOauth : null
    if (!current
        || current.accessToken === bundle.accessToken
        || codexBundleIsNewer(fresh, current)) {
      await saveCodexOAuthBundle(fresh)
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
async function codexRefreshOnce(bundle: CodexOAuthBundle): Promise<PlanUsageResult> {
  const effective = await convergedCodexBundle(bundle)
  let result = await queryCodexPlanUsage(effective)
  if (!result.available && result.reason === 'unauthorized' && await hostMayRefreshCredentials()) {
    const fresh = await refreshAndPersistCodexBundle(effective)
    if (fresh) result = await queryCodexPlanUsage(fresh)
  }
  return result
}

// ── Snapshot slices ────────────────────────────────────────────────────

/**
 * The Claude plan-usage slice of the snapshot. Checks the stored credential
 * kind (a local read, so auth changes show immediately), kicks a detached
 * refresh at most once per interval, and returns the cached result (null
 * before the first refresh lands).
 */
export async function planUsageForSnapshot(): Promise<PlanUsageResult | null> {
  const creds = await loadClaudeCredentialsFile()
  if (!creds || creds.kind !== 'oauth') {
    reset(states.claude)
    return creds
      ? { available: false, reason: 'api-key' }
      : { available: false, reason: 'no-credentials' }
  }
  const bundle = creds.claudeAiOauth
  kickRefresh(states.claude, REFRESH_INTERVAL_MS, () => claudeRefreshOnce(bundle, states.claude))
  return states.claude.current
}

/**
 * The Codex plan-usage slice of the snapshot. Only ChatGPT (OAuth) auth is
 * queryable; otherwise null, and the readout omits Codex.
 */
export async function codexPlanUsageForSnapshot(): Promise<PlanUsageResult | null> {
  const creds = await loadCodexCredentialsFile()
  if (!creds || creds.kind !== 'oauth') {
    reset(states.codex)
    return null
  }
  const bundle = creds.codexOauth
  kickRefresh(states.codex, REFRESH_INTERVAL_MS, () => codexRefreshOnce(bundle))
  return states.codex.current
}

/**
 * On-demand refresh when the webapp's usage popover opens, so the numbers
 * are at most a minute old. Covers every signed-in tool; results arrive in
 * the next snapshot.
 */
export async function requestPlanUsageRefresh(): Promise<void> {
  await kickSignedInTools(ON_DEMAND_MIN_INTERVAL_MS)
}

/**
 * The background refresh, on the server's own interval (see server-run).
 * The upstream endpoints have no push, so this must poll. The caller runs it
 * only while a client is connected, so a closed webapp causes no upstream
 * traffic.
 */
export async function refreshPlanUsage(): Promise<void> {
  await kickSignedInTools(REFRESH_INTERVAL_MS)
}

/** Kick every signed-in tool's engine, subject to `minIntervalMs`. */
async function kickSignedInTools(minIntervalMs: number): Promise<void> {
  const [claude, codex] = await Promise.all([
    loadClaudeCredentialsFile(),
    loadCodexCredentialsFile(),
  ])
  if (claude?.kind === 'oauth') {
    const bundle = claude.claudeAiOauth
    kickRefresh(states.claude, minIntervalMs, () => claudeRefreshOnce(bundle, states.claude))
  }
  if (codex?.kind === 'oauth') {
    const bundle = codex.codexOauth
    kickRefresh(states.codex, minIntervalMs, () => codexRefreshOnce(bundle))
  }
}
