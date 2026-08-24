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
import { notifyWorktreeListChanged } from '#notify'
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
 * Upstream traffic is gated on a webapp client being connected: snapshots
 * are only built for connected clients, and the background cycle
 * (`refreshPlanUsage`) is only ticked while the hub holds a connection.
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
    notifyWorktreeListChanged()
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
    // Another writer (a session refresh captured by the proxy or adopted by
    // the harvest, `yaac auth update`) may have replaced the credential while
    // our refresh was in flight.
    //
    // Losing that race must not mean dropping `fresh` on the floor. The grant
    // already SPENT the token we started from, so the credential it replaced
    // is dead whatever we do here — discarding the replacement because the
    // file moved would leave the install holding a token nothing can refresh,
    // which is a permanent logout rather than a lost cycle. So the tie is
    // broken the way every other credential decision here is: newest wins.
    // A writer that stored something genuinely newer (a fresh login, a
    // rotation a session did after ours) keeps it; otherwise ours lands.
    const stored = await loadClaudeCredentialsFile()
    const current = stored?.kind === 'oauth' ? stored.claudeAiOauth : null
    if (!current
        || current.accessToken === bundle.accessToken
        || claudeBundleIsNewer(fresh, current)) {
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

/**
 * Adopt anything a running worktree has refreshed, then re-read the stored
 * credential — the one to actually spend this cycle.
 *
 * Under a mediated runtime this finds nothing (the proxy has already written
 * every session refresh to the host store) and costs a few file reads. Under
 * an unmediated one it is the difference between querying with the token an
 * agent just minted and querying with the superseded one it replaced — and,
 * more importantly, between refreshing a spent token and not needing to
 * refresh at all. Never throws: a failure leaves `fallback` in play, which is
 * exactly where the cycle would have been anyway.
 */
async function convergedClaudeBundle(fallback: ClaudeOAuthBundle): Promise<ClaudeOAuthBundle> {
  // Nothing to converge where a proxy mediates egress: the workspace holds a
  // sentinel, and the refresh it drives is captured to the host store on the
  // way out — so `fallback`, read from that store, is already the live token
  // and sweeping every project would only cost file reads.
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

/** The Codex twin of `convergedClaudeBundle`, gated for the same reason. */
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

/** One Claude usage cycle: adopt anything a worktree refreshed, refresh an
 *  expired token if this host is the one that may, query usage and (once per
 *  credential) the rate-limit tier, and retry once after a refresh if an
 *  unexpired token comes back unauthorized. */
async function claudeRefreshOnce(bundle: ClaudeOAuthBundle, state: UsageState): Promise<PlanUsageResult> {
  let effective = await convergedClaudeBundle(bundle)
  let tokenRefreshTried = false
  // An expired access token would only 401: refresh it ourselves first —
  // but only when no live workspace holds a copy of the credential we would
  // be rotating out from under it (see `hostMayRefreshCredentials`). With a
  // proxy that never applies; without one, a running agent refreshes on its
  // own and the harvest above is how we get that token instead.
  if (effective.expiresAt <= Date.now() && await hostMayRefreshCredentials()) {
    tokenRefreshTried = true
    effective = await refreshAndPersistClaudeBundle(effective) ?? effective
  }
  let [result, tier] = await Promise.all([
    queryClaudePlanUsage(effective),
    state.rateLimitTier === null ? queryClaudeRateLimitTier(effective) : Promise.resolve(state.rateLimitTier),
  ])
  // Unauthorized despite an unexpired stamp (revoked token, stale expiresAt):
  // one refresh + retry before surfacing the failure — under the same
  // may-we-rotate gate as the proactive path above, because a 401 here means
  // a live agent's copy is equally dead and its own refresh is the one that
  // should mint the replacement.
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
    // Same newest-wins tie-break as the Claude twin, and it matters more
    // here: Codex refresh tokens are single-use, so a discarded rotation is
    // guaranteed unrecoverable rather than merely likely to be.
    const stored = await loadCodexCredentialsFile()
    const current = stored?.kind === 'oauth' ? stored.codexOauth : null
    if (!current
        || current.accessToken === bundle.accessToken
        || codexBundleIsNewer(fresh, current)) {
      await saveCodexOAuthBundle(fresh)
    }
  } catch (err) {
    serverLog(`[server] failed to persist refreshed Codex OAuth bundle: ${String(err)}`)
  }
  return fresh
}

/** One Codex usage cycle. Unlike Claude, Codex refreshes reactively only —
 *  never proactively on expiry — because its refresh tokens rotate: a session
 *  keeps the host token fresh (through the proxy where there is one, through
 *  the harvest where there is not), so we query with the converged token and
 *  only refresh when it actually comes back unauthorized, and only when no
 *  live workspace holds the credential we would rotate. */
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
 * The Claude plan-usage slice of the server snapshot. Gates on the stored
 * credential kind (a local file read, so an auth change reflects in the
 * snapshot that change pushes), returns the in-memory result, and kicks a
 * detached upstream refresh at most once per interval — which is what makes
 * a freshly connected client's first snapshot warm. Returns null before the
 * first refresh lands.
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
  await kickSignedInTools(ON_DEMAND_MIN_INTERVAL_MS)
}

/**
 * The background cycle, driven by the server's own clock.
 *
 * This is the one genuinely irreducible poll in the server: the upstream
 * usage endpoints have no push, so freshness can only come from asking. It
 * used to free-ride on the fact that a snapshot was rebuilt after every
 * reconcile pass — which stopped being true once snapshots became purely
 * edge-driven, so it owns an explicit interval instead (see server-run).
 * The caller gates on having a connected client, which preserves the
 * standing rule that a closed webapp produces no upstream traffic.
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
