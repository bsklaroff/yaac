import { queryClaudePlanUsage, queryClaudeRateLimitTier } from '@/lib/auth/usage'
import { loadClaudeCredentialsFile } from '@/lib/project/tool-auth'
import { notifySessionListChanged } from '@/daemon/sessions-changed'
import { daemonLog } from '@/daemon/log'
import type { ClaudeOAuthBundle, PlanUsageResult } from '@/shared/types'

/**
 * Daemon-side owner of the subscription plan-usage readout. The webapp
 * never queries upstream: this module refreshes from the usage endpoint on
 * its own cadence and `buildSnapshot` reads whatever is current, so the
 * value rides the same pushed snapshot as every other ambient badge.
 *
 * Snapshots are only built while a webapp client is connected, which makes
 * that the refresh gate for free: no open webapp, no upstream traffic.
 */
const REFRESH_INTERVAL_MS = 5 * 60_000
/** Floor for on-demand nudges (webapp popover opens): a nudge inside a
 *  minute of the last attempt is ignored, so an eagerly re-opened popover
 *  can't burn the endpoint's tight rate budget. */
const ON_DEMAND_MIN_INTERVAL_MS = 60_000
/** Keep showing the last good result across transient upstream trouble
 *  (429 throttles, blips) for this long before surfacing the failure. */
const STALE_GRACE_MS = 15 * 60_000

let current: PlanUsageResult | null = null
/** When `current` last held a successful (available) result. */
let goodAt = 0
/** When the last upstream attempt started — failures also wait out the
 *  interval, matching the endpoint's observed ~4min 429 lockout. */
let attemptAt = 0
let inflight = false
/** The org's rate-limit tier ('default_claude_max_20x' — the Max 20x vs
 *  10x distinction). Fetched from the profile endpoint alongside the first
 *  usage refresh and then kept for the credential's lifetime (it only
 *  changes on plan changes); null re-fetches on the next cycle. */
let rateLimitTier: string | null = null
/** Bumped by reset() so a refresh that was in flight across a credential
 *  change discards its result instead of resurfacing pre-change data. */
let generation = 0

/** Forget everything — on credential change (and between tests) the next
 *  snapshot starts from scratch rather than resurfacing pre-change data. */
function reset(): void {
  current = null
  goodAt = 0
  attemptAt = 0
  inflight = false
  rateLimitTier = null
  generation++
}

export function _resetPlanUsageForTests(): void {
  reset()
}

/**
 * The plan-usage slice of the daemon snapshot. Gates on the stored
 * credential kind (a local file read, so auth changes reflect on the next
 * 5s tick), returns the in-memory result, and kicks a detached upstream
 * refresh at most once per interval. Returns null before the first
 * refresh lands.
 */
export async function planUsageForSnapshot(): Promise<PlanUsageResult | null> {
  const creds = await loadClaudeCredentialsFile()
  if (!creds || creds.kind !== 'oauth') {
    reset()
    return creds
      ? { available: false, reason: 'api-key' }
      : { available: false, reason: 'no-credentials' }
  }
  kickRefresh(creds.claudeAiOauth, REFRESH_INTERVAL_MS)
  return current
}

/**
 * On-demand nudge — the webapp fires this when the usage popover opens, so
 * the user looking at the numbers gets them at most a minute old instead
 * of five. Fire-and-forget: the result rides the next pushed snapshot.
 */
export async function requestPlanUsageRefresh(): Promise<void> {
  const creds = await loadClaudeCredentialsFile()
  if (!creds || creds.kind !== 'oauth') return
  kickRefresh(creds.claudeAiOauth, ON_DEMAND_MIN_INTERVAL_MS)
}

/** Start a detached upstream refresh unless one is running or the last
 *  attempt is fresher than `minIntervalMs`. */
function kickRefresh(bundle: ClaudeOAuthBundle, minIntervalMs: number): void {
  if (inflight || Date.now() - attemptAt < minIntervalMs) return
  inflight = true
  attemptAt = Date.now()
  const startedGeneration = generation
  void Promise.all([
    queryClaudePlanUsage(bundle),
    rateLimitTier === null ? queryClaudeRateLimitTier(bundle) : Promise.resolve(rateLimitTier),
  ]).then(([result, tier]) => {
    if (generation !== startedGeneration) return
    inflight = false
    rateLimitTier = tier
    if (result.available) {
      current = { ...result, rateLimitTier }
      goodAt = Date.now()
    } else {
      daemonLog(`[daemon] plan-usage refresh failed: ${result.reason}${result.message ? ` (${result.message})` : ''}`)
      // Bridge transient trouble with the last good result; only a
      // sustained outage (past the grace window) hides the readout.
      if (!(current?.available && Date.now() - goodAt < STALE_GRACE_MS)) {
        current = result
      }
    }
    // Deliver without waiting for the next background tick — the hub
    // dedupes, so an unchanged snapshot costs no traffic.
    notifySessionListChanged()
  })
}
