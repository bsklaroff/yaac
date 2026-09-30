import { z } from 'zod'
import type {
  ClaudeOAuthBundle,
  CodexOAuthBundle,
  PlanUsageLimit,
  PlanUsageResult,
} from '@yaac/shared/types'

/**
 * The endpoint behind Claude Code's /usage screen. Subscription-only: it
 * takes the OAuth access token as a Bearer (plus the OAuth beta header).
 */
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** Account profile for the OAuth token. Its org rate-limit tier (e.g.
 *  'default_claude_max_20x') is the only place Max 20x vs 10x shows up; the
 *  bundle's subscriptionType is just 'max'. */
export const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

/** The part of the usage payload we read: the `limits` array, one row per
 *  plan limit. Everything else is ignored. */
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
 * Query the profile endpoint for the org's rate-limit tier. Never throws;
 * null covers every failure and a missing field, so the caller can retry
 * later and show the bare subscriptionType meanwhile.
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
 * Query the Claude usage endpoint. Never throws; HTTP and network failures
 * return `{ available: false }`. Cadence, caching and throttling live in
 * ./plan-usage.ts: the endpoint rate-limits hard (a burst of ~8 requests got
 * a 429 with retry-after ≈4min), so never call this in a loop.
 *
 * On a 401 the caller refreshes the bundle (./claude-oauth.ts) and retries.
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
      // Filled in by the per-credential profile fetch in ./plan-usage.ts,
      // so each usage refresh doesn't also hit the rate-limited profile API.
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

// ── Codex (ChatGPT) subscription usage ─────────────────────────────────

/**
 * The endpoint behind Codex CLI's `/status` rate-limit readout in ChatGPT
 * auth mode. Takes the OAuth access token as a Bearer plus the
 * `ChatGPT-Account-Id` header; unavailable with api-key auth.
 */
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

/** One rolling window from wham/usage (RateLimitWindowSnapshot). `reset_at`
 *  is a unix timestamp in seconds; `limit_window_seconds` is the window
 *  length (5h = 18000, weekly = 604800). */
const codexWindowSchema = z.object({
  used_percent: z.number(),
  limit_window_seconds: z.number().nullish(),
  reset_at: z.number().nullish(),
})

/** The part of wham/usage we read: the plan type and the two rate-limit
 *  windows. */
const codexUsageSchema = z.object({
  plan_type: z.string().nullish(),
  rate_limit: z.object({
    primary_window: codexWindowSchema.nullish(),
    secondary_window: codexWindowSchema.nullish(),
  }).nullish(),
})

type CodexWindow = z.infer<typeof codexWindowSchema>

function codexLimit(kind: 'codex_primary' | 'codex_secondary', w: CodexWindow): PlanUsageLimit {
  return {
    kind,
    percent: w.used_percent,
    // wham/usage carries no per-window severity; percent drives the tone.
    severity: 'normal',
    resetsAt: typeof w.reset_at === 'number' && w.reset_at > 0
      ? new Date(w.reset_at * 1000).toISOString()
      : null,
    modelName: null,
    windowMinutes: typeof w.limit_window_seconds === 'number'
      ? Math.round(w.limit_window_seconds / 60)
      : null,
  }
}

/**
 * Normalize a wham/usage payload to the wire shape: the ChatGPT plan type
 * and whichever of the primary/secondary windows are present. Throws on an
 * unrecognized body.
 */
export function parseCodexPlanUsage(
  body: unknown,
): { subscriptionType: string | null; limits: PlanUsageLimit[] } {
  const parsed = codexUsageSchema.safeParse(body)
  if (!parsed.success) throw new Error('unrecognized codex usage response shape')
  const rl = parsed.data.rate_limit
  const limits: PlanUsageLimit[] = []
  if (rl?.primary_window) limits.push(codexLimit('codex_primary', rl.primary_window))
  if (rl?.secondary_window) limits.push(codexLimit('codex_secondary', rl.secondary_window))
  return { subscriptionType: parsed.data.plan_type ?? null, limits }
}

/** Decode a JWT payload without verifying it (display claims only, never
 *  auth). Null if unparseable. */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.')
  if (parts.length < 2) return null
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const parsed: unknown = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** The `ChatGPT-Account-Id` header value: the bundle's stored id, else the
 *  access token's `chatgpt_account_id` claim. */
function codexAccountId(bundle: CodexOAuthBundle): string | null {
  if (bundle.accountId) return bundle.accountId
  const claims = decodeJwtPayload(bundle.accessToken)
  const auth = claims?.['https://api.openai.com/auth']
  if (auth && typeof auth === 'object') {
    const id = (auth as Record<string, unknown>).chatgpt_account_id
    if (typeof id === 'string' && id) return id
  }
  return null
}

function codexHeaders(bundle: CodexOAuthBundle): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${bundle.accessToken}`,
    // A plain UA is enough for this read-only endpoint.
    'User-Agent': 'codex-cli',
  }
  const accountId = codexAccountId(bundle)
  if (accountId) headers['ChatGPT-Account-Id'] = accountId
  return headers
}

/**
 * Query the Codex usage endpoint. Never throws; like queryClaudePlanUsage,
 * failures return `{ available: false }`. Cadence, caching and refresh on
 * 401/403 live in ./plan-usage.ts.
 */
export async function queryCodexPlanUsage(
  bundle: CodexOAuthBundle,
): Promise<PlanUsageResult> {
  try {
    const res = await fetch(CODEX_USAGE_URL, {
      headers: codexHeaders(bundle),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 401 || res.status === 403) {
      return { available: false, reason: 'unauthorized' }
    }
    if (!res.ok) {
      return {
        available: false,
        reason: 'error',
        message: `codex usage endpoint returned ${res.status}`,
      }
    }
    const { subscriptionType, limits } = parseCodexPlanUsage(await res.json())
    return {
      available: true,
      subscriptionType,
      // Codex has no separate tier; the plan type says it all.
      rateLimitTier: null,
      limits,
    }
  } catch (err) {
    return {
      available: false,
      reason: 'error',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
