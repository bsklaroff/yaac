import { z } from 'zod'
import type { ClaudeOAuthBundle, PlanUsageLimit, PlanUsageResult } from '@/shared/types'

/**
 * The endpoint behind Claude Code's own /usage screen. Subscription-only:
 * it authenticates with the OAuth access token as a Bearer (plus the OAuth
 * beta header) and knows nothing about api keys.
 */
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** Account/organization profile for the OAuth token — carries the org's
 *  rate-limit tier (e.g. 'default_claude_max_20x'), which is the only
 *  place the Max 20x vs 10x distinction shows up (the credential bundle's
 *  subscriptionType is just 'max'). */
export const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

/**
 * The slice of the upstream payload we consume. The endpoint returns far
 * more (spend, extra-usage credits, per-surface buckets); the `limits`
 * array is the general shape — one row per plan limit — so everything else
 * is ignored rather than modeled.
 */
const upstreamUsageSchema = z.object({
  limits: z.array(z.object({
    kind: z.string(),
    percent: z.number(),
    severity: z.string(),
    resets_at: z.string().nullish(),
    scope: z.object({
      model: z.object({ display_name: z.string().nullish() }).nullish(),
    }).nullish(),
  })),
})

/**
 * Normalize the upstream usage payload to the wire shape. Throws when the
 * body doesn't carry a recognizable `limits` array.
 */
export function parsePlanUsageLimits(body: unknown): PlanUsageLimit[] {
  const parsed = upstreamUsageSchema.safeParse(body)
  if (!parsed.success) throw new Error('unrecognized usage response shape')
  return parsed.data.limits.map((l) => ({
    kind: l.kind,
    percent: l.percent,
    severity: l.severity,
    resetsAt: l.resets_at ?? null,
    modelName: l.scope?.model?.display_name ?? null,
  }))
}

const upstreamProfileSchema = z.object({
  organization: z.object({ rate_limit_tier: z.string().nullish() }).nullish(),
})

function oauthHeaders(bundle: ClaudeOAuthBundle): Record<string, string> {
  return {
    'Authorization': `Bearer ${bundle.accessToken}`,
    'anthropic-beta': 'oauth-2025-04-20',
  }
}

/**
 * One plain query of the profile endpoint for the org's rate-limit tier.
 * Never throws; null covers every failure (and a missing field) so the
 * caller can retry on its own cadence and degrade to the bare
 * subscriptionType label meanwhile.
 */
export async function queryClaudeRateLimitTier(
  bundle: ClaudeOAuthBundle,
): Promise<string | null> {
  try {
    const res = await fetch(CLAUDE_PROFILE_URL, {
      headers: oauthHeaders(bundle),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const parsed = upstreamProfileSchema.safeParse(await res.json())
    return parsed.success ? parsed.data.organization?.rate_limit_tier ?? null : null
  } catch {
    return null
  }
}

/**
 * One plain query of the usage endpoint with the given OAuth bundle.
 * Never throws — HTTP failures and network errors come back as
 * `{ available: false }`. Refresh cadence, caching, and bridging upstream
 * throttles all live with the caller (server/plan-usage.ts): the endpoint
 * rate-limits hard (observed: a burst of ~8 requests earned a 429 with
 * retry-after ≈4min), so nothing should call this in a loop.
 *
 * A 401 means the access token is expired or revoked; the caller refreshes
 * the bundle (lib/auth/claude-oauth.ts) and retries before surfacing it.
 */
export async function queryClaudePlanUsage(
  bundle: ClaudeOAuthBundle,
): Promise<PlanUsageResult> {
  try {
    const res = await fetch(CLAUDE_USAGE_URL, {
      headers: oauthHeaders(bundle),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 401 || res.status === 403) {
      return { available: false, reason: 'unauthorized' }
    }
    if (!res.ok) {
      return {
        available: false,
        reason: 'error',
        message: `usage endpoint returned ${res.status}`,
      }
    }
    return {
      available: true,
      subscriptionType: bundle.subscriptionType ?? null,
      // Filled in by the server's per-credential profile fetch
      // (server/plan-usage.ts) — not queried here, so a 5-minutely usage
      // refresh doesn't double the load on the rate-limited OAuth API.
      rateLimitTier: null,
      limits: parsePlanUsageLimits(await res.json()),
    }
  } catch (err) {
    return {
      available: false,
      reason: 'error',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
