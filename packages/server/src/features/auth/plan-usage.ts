import { queryClaudePlanUsage, queryClaudeRateLimitTier, queryCodexPlanUsage } from './usage'
import { refreshClaudeOAuthBundle } from './claude-oauth'
import { refreshCodexOAuthBundle } from './codex-oauth'
import {
  loadClaudeCredentialsFile,
  saveClaudeOAuthBundle,
  loadCodexCredentialsFile,
  saveCodexOAuthBundle,
} from '@yaac/shared/tool-auth'
import { notifySessionListChanged } from '#notify'
import { serverLog } from '#log'
import type { ClaudeOAuthBundle, CodexOAuthBundle, PlanUsageResult } from '@yaac/shared/types'

/**
 * Server-side owner of the subscription plan-usage readouts. The webapp
 * never queries upstream: this module refreshes each tool's usage endpoint
 * on its own cadence and `buildSnapshot` reads whatever is current, so the
 * values ride the same pushed snapshot as every other ambient badge.
 *
 * One engine drives both Claude (api.anthropic.com/api/oauth/usage) and
 * Codex (chatgpt.com/backend-api/wham/usage) with per-tool state; the two
 * differ only in how a fresh result is produced (`claudeRefreshOnce` /
 * `codexRefreshOnce`).
 *
 * Snapshots are only built while a webapp client is connected, which makes
 * that the refresh gate for free: no open webapp, no upstream traffic.
 */
const REFRESH_INTERVAL_MS = 5 * 60_000
/** Floor for on-demand nudges (webapp popover opens): a nudge inside a
 *  minute of the last attempt is ignored, so an eagerly re-opened popover
 *  can't burn a rate-limited endpoint's tight budget. */
const ON_DEMAND_MIN_INTERVAL_MS = 60_000
/** Keep showing the last good result across transient upstream trouble
 *  (429 throttles, blips) for this long before surfacing the failure. */
const STALE_GRACE_MS = 15 * 60_000

interface UsageState {
  current: PlanUsageResult | null
  /** When `current` last held a successful (available) result. */
  goodAt: number
  /** When the last upstream attempt started — failures also wait out the
   *  interval, matching a rate-limited endpoint's observed lockout. */
  attemptAt: number
  inflight: boolean
  /** Claude only: the org's rate-limit tier ('default_claude_max_20x' — the
   *  Max 20x vs 10x distinction). Fetched from the profile endpoint alongside
   *  the first usage refresh and then kept for the credential's lifetime;
   *  null re-fetches on the next cycle. Always null for Codex. */
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

/** Forget a tool's state — on credential change (and between tests) the next
 *  snapshot starts from scratch rather than resurfacing pre-change data. */
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
 * Start a detached upstream refresh for a tool unless one is running or the
 * last attempt is fresher than `minIntervalMs`. `runOnce` produces a fresh
 * result (handling its own token refresh / retries); the engine owns cadence,
 * the generation guard, staleness bridging, and the snapshot push.
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
      // Cache Claude's tier once it lands; leave null (re-fetch next cycle)
      // until it does. Codex results carry null, so this is a no-op there.
      state.rateLimitTier = result.rateLimitTier ?? state.rateLimitTier
    } else {
      serverLog(`[server] plan-usage refresh failed: ${result.reason}${result.message ? ` (${result.message})` : ''}`)
      // Bridge transient trouble with the last good result; only a sustained
      // outage (past the grace window) hides the readout.
      if (!(state.current?.available && Date.now() - state.goodAt < STALE_GRACE_MS)) {
        state.current = result
      }
    }
    // Deliver without waiting for the next background tick — the hub dedupes,
    // so an unchanged snapshot costs no traffic.
    notifySessionListChanged()
  })()
}

// ── Claude ─────────────────────────────────────────────────────────────

/**
 * Refresh Claude's OAuth bundle upstream and persist it, so the fresh token
 * also serves sessions and the next server restart. Never throws; null means
 * the refresh didn't produce a usable bundle.
 */
async function refreshAndPersistClaudeBundle(
  bundle: ClaudeOAuthBundle,
): Promise<ClaudeOAuthBundle | null> {
  const fresh = await refreshClaudeOAuthBundle(bundle)
  if (!fresh) return null
  try {
    // Another writer (a session refresh captured by the proxy, `yaac auth
    // update`) may have replaced the credential while our refresh was in
    // flight — persist only while ours is still the stored one.
    const stored = await loadClaudeCredentialsFile()
    if (stored?.kind === 'oauth' && stored.claudeAiOauth.accessToken === bundle.accessToken) {
      await saveClaudeOAuthBundle(fresh)
    }
  } catch (err) {
    // Only the write can throw here (the loads swallow their own failures),
    // and losing it costs nothing this cycle: `fresh` still serves the query
    // and the next refresh tries the persist again.
    serverLog(`[server] failed to persist refreshed Claude OAuth bundle: ${String(err)}`)
  }
  return fresh
}

/** One Claude usage cycle: refresh an expired token first, query usage and
 *  (once per credential) the rate-limit tier, and retry once after a
 *  refresh if an unexpired token comes back unauthorized. */
async function claudeRefreshOnce(bundle: ClaudeOAuthBundle, state: UsageState): Promise<PlanUsageResult> {
  let effective = bundle
  let tokenRefreshTried = false
  // An expired access token would only 401: refresh it ourselves first.
  // Running sessions keep the host token fresh (the proxy captures their
  // refresh traffic); this covers the no-running-session gap.
  if (bundle.expiresAt <= Date.now()) {
    tokenRefreshTried = true
    effective = await refreshAndPersistClaudeBundle(bundle) ?? bundle
  }
  let [result, tier] = await Promise.all([
    queryClaudePlanUsage(effective),
    state.rateLimitTier === null ? queryClaudeRateLimitTier(effective) : Promise.resolve(state.rateLimitTier),
  ])
  // Unauthorized despite an unexpired stamp (revoked token, stale expiresAt):
  // one refresh + retry before surfacing the failure.
  if (!result.available && result.reason === 'unauthorized' && !tokenRefreshTried) {
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
    const stored = await loadCodexCredentialsFile()
    if (stored?.kind === 'oauth' && stored.codexOauth.accessToken === bundle.accessToken) {
      await saveCodexOAuthBundle(fresh)
    }
  } catch (err) {
    serverLog(`[server] failed to persist refreshed Codex OAuth bundle: ${String(err)}`)
  }
  return fresh
}

/** One Codex usage cycle. Unlike Claude, Codex refreshes reactively only —
 *  never proactively on expiry — because its refresh tokens rotate: a running
 *  session keeps the host token fresh through the proxy, so we query with the
 *  stored token and only refresh when it actually comes back unauthorized. */
async function codexRefreshOnce(bundle: CodexOAuthBundle): Promise<PlanUsageResult> {
  let result = await queryCodexPlanUsage(bundle)
  if (!result.available && result.reason === 'unauthorized') {
    const fresh = await refreshAndPersistCodexBundle(bundle)
    if (fresh) result = await queryCodexPlanUsage(fresh)
  }
  return result
}

// ── Snapshot slices ────────────────────────────────────────────────────

/**
 * The Claude plan-usage slice of the server snapshot. Gates on the stored
 * credential kind (a local file read, so auth changes reflect on the next
 * 5s tick), returns the in-memory result, and kicks a detached upstream
 * refresh at most once per interval. Returns null before the first refresh
 * lands.
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
 * The Codex plan-usage slice of the server snapshot. Only ChatGPT (OAuth)
 * auth is queryable; api-key auth and not-signed-in both return null so the
 * combined readout simply omits the Codex section.
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
 * On-demand nudge — the webapp fires this when the usage popover opens, so
 * the user looking at the numbers gets them at most a minute old instead of
 * five. Nudges every signed-in tool the readout can show (Claude and Codex).
 * Fire-and-forget: results ride the next pushed snapshot.
 */
export async function requestPlanUsageRefresh(): Promise<void> {
  const [claude, codex] = await Promise.all([
    loadClaudeCredentialsFile(),
    loadCodexCredentialsFile(),
  ])
  if (claude?.kind === 'oauth') {
    const bundle = claude.claudeAiOauth
    kickRefresh(states.claude, ON_DEMAND_MIN_INTERVAL_MS, () => claudeRefreshOnce(bundle, states.claude))
  }
  if (codex?.kind === 'oauth') {
    const bundle = codex.codexOauth
    kickRefresh(states.codex, ON_DEMAND_MIN_INTERVAL_MS, () => codexRefreshOnce(bundle))
  }
}
