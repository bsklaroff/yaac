import { z } from 'zod'
import type {
  ClaudeOAuthBundle,
  CodexOAuthBundle,
  PlanUsageLimit,
  PlanUsageResult,
} from '@yaac/shared/types'

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

// ── Codex (ChatGPT) subscription usage ─────────────────────────────────

/**
 * The endpoint behind Codex CLI's own `/status` rate-limit readout, in
 * ChatGPT auth mode: `chatgpt.com/backend-api/wham/usage`. Codex polls it on
 * a 60s cadence; like Claude's, it authenticates with the OAuth access token
 * as a Bearer plus the `ChatGPT-Account-Id` header, and knows nothing about
 * api keys. Not reachable for api-key ("OPENAI_API_KEY") Codex auth.
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

/**
 * The slice of wham/usage we consume. The payload flattens
 * RateLimitStatusPayload (`plan_type`, `rate_limit`, …) with reset-credit
 * fields; we read only the plan type and the two rate-limit windows.
 */
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
 * Normalize a wham/usage payload to the wire shape. Returns the ChatGPT plan
 * type and the primary/secondary windows (each present only when the upstream
 * reports it). Throws when the body doesn't carry a recognizable
 * `rate_limit` object.
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

/** Decode a JWT payload without verifying it — we only read display claims
 *  (never trust these for auth). Returns null for anything unparseable. */
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

/** The ChatGPT account id for the `ChatGPT-Account-Id` header: the bundle's
 *  stored id, else the `chatgpt_account_id` claim carried in the access
 *  token JWT (under the `https://api.openai.com/auth` namespace). */
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
    // Codex identifies itself with a `codex_cli_rs`-flavored UA; a plain
    // client UA is enough for the read-only usage endpoint.
    'User-Agent': 'codex-cli',
  }
  const accountId = codexAccountId(bundle)
  if (accountId) headers['ChatGPT-Account-Id'] = accountId
  return headers
}

/**
 * One plain query of the Codex usage endpoint with the given OAuth bundle.
 * Never throws — HTTP failures and network errors come back as
 * `{ available: false }`, mirroring queryClaudePlanUsage. Refresh cadence,
 * caching, and 401-driven token refresh live with the caller
 * (server/plan-usage.ts). A 401/403 means the access token is expired or
 * revoked; the caller refreshes the bundle and retries before surfacing it.
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
      // Codex has no separate rate-limit-tier multiplier; the plan type in
      // subscriptionType is the whole story.
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
