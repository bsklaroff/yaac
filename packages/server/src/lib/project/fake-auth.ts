import {
  saveClaudeOAuthBundle,
  fanOutClaudePlaceholders,
  PLACEHOLDER_ACCESS_TOKEN,
  PLACEHOLDER_REFRESH_TOKEN,
  PLACEHOLDER_GH_TOKEN,
} from '@yaac/shared/tool-auth'
import { addEntry } from '#lib/project/credentials'
import type { ClaudeOAuthBundle } from '@yaac/shared/types'

/** Credential pattern seeded by `auth fake github`. */
export const FAKE_GITHUB_PATTERN = 'github.com/*'

/**
 * Scopes Claude Code's real OAuth bundle carries. Mirrored into the fake bundle
 * so Claude Code inside a session sees a plausible credential.
 */
const FAKE_CLAUDE_SCOPES = [
  'user:file_upload',
  'user:inference',
  'user:mcp_servers',
  'user:profile',
  'user:sessions:claude_code',
]

/** A fake bundle's lifetime: ~1y out so Claude Code won't refresh on first use. */
const FAKE_BUNDLE_TTL_MS = 365 * 24 * 60 * 60 * 1000

/**
 * Build a fake Claude OAuth bundle whose tokens are the proxy placeholders
 * (`yaac-ph-access` / `yaac-ph-refresh`). A parent yaac's MITM proxy swaps these
 * sentinels for the real credential, so a session created from this bundle
 * authenticates against the real API over the chained-egress path — this is
 * what makes yaac-in-yaac work (the inner session must send OAuth, not an
 * api-key, because the api-key swap can't chain through an OAuth outer proxy).
 */
export function buildFakeClaudeOAuthBundle(): ClaudeOAuthBundle {
  return {
    accessToken: PLACEHOLDER_ACCESS_TOKEN,
    refreshToken: PLACEHOLDER_REFRESH_TOKEN,
    expiresAt: Date.now() + FAKE_BUNDLE_TTL_MS,
    scopes: [...FAKE_CLAUDE_SCOPES],
    subscriptionType: 'max',
  }
}

/**
 * Seed a fake Claude OAuth credential into the data dir and fan the placeholder
 * bundle out to every existing project — matching a real `auth update` OAuth
 * login, so already-added projects pick it up without a re-seed.
 */
export async function seedFakeClaudeOAuth(): Promise<void> {
  const bundle = buildFakeClaudeOAuthBundle()
  await saveClaudeOAuthBundle(bundle)
  await fanOutClaudePlaceholders(bundle)
}

/**
 * Seed a fake HTTPS GitHub credential (`github.com/*`) into the data dir.
 * The token is the proxy placeholder (`yaac-ph-gh-token`), not a random
 * fake — same trick as the fake Claude bundle above. A parent yaac's MITM
 * proxy swaps the sentinel for the real GitHub token, so `gh` (and HTTPS
 * git) inside a session authenticate against the real API over the
 * chained-egress path. A genuinely fake value would instead be forwarded
 * as-is and rejected (401) one hop too early. Merges with any existing
 * entries (replaces only the matching pattern).
 */
export async function seedFakeGithubCredential(): Promise<void> {
  await addEntry({ kind: 'https', pattern: FAKE_GITHUB_PATTERN, token: PLACEHOLDER_GH_TOKEN })
}
