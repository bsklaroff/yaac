import {
  isPlaceholderClaudeBundle,
  loadClaudeCredentialsFile,
  loadOpencodeCredentialsFile,
  loadPiCredentialsFile,
  saveClaudeOAuthBundle,
  saveOpencodeCredentialsFile,
  savePiCredentialsFile,
  fanOutClaudePlaceholders,
  PLACEHOLDER_ACCESS_TOKEN,
  PLACEHOLDER_REFRESH_TOKEN,
  PLACEHOLDER_API_KEY,
  PLACEHOLDER_GH_TOKEN,
} from '@yaac/shared/tool-auth'
import { getGitCredentialByName, insertGitCredential } from '#db'
import { ServerError } from '@yaac/shared/errors'
import type { ClaudeOAuthBundle, FakeAuthKind } from '@yaac/shared/types'

/** The git credential `auth fake github` seeds. */
export const FAKE_GITHUB_CREDENTIAL_NAME = 'fake-github'

/**
 * Scopes Claude Code's real OAuth bundle carries. Mirrored into the fake bundle
 * so Claude Code inside a worktree sees a plausible credential.
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
 * sentinels for the real credential, so a worktree created from this bundle
 * authenticates against the real API over the chained-egress path — this is
 * what makes yaac-in-yaac work (the inner worktree must send OAuth, not an
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
async function seedFakeClaudeOAuth(): Promise<void> {
  const bundle = buildFakeClaudeOAuthBundle()
  await saveClaudeOAuthBundle(bundle)
  await fanOutClaudePlaceholders(bundle)
}

// NOTE: no `codex-oauth` fake kind. Codex sends a `ChatGPT-Account-Id` header
// the proxy passes through unchanged, so a fake bundle's sentinel account id
// would reach OpenAI alongside a parent's real access token (a mismatch) —
// codex can't chain through a parent proxy the way the OAuth-token-only tools
// (claude) and api-key tools (opencode/pi) can. Left out until the proxy also
// owns the account id.

/**
 * Seed the fake HTTPS GitHub credential, `fake-github`, unless it exists —
 * what `yaac project add <url> fake-github` then clones with. The token
 * is the proxy placeholder (`yaac-ph-gh-token`), not a random fake — same
 * trick as the fake Claude bundle above. A parent yaac's MITM proxy swaps
 * the sentinel for the real GitHub token, so `gh` (and HTTPS git) inside a
 * worktree authenticate against the real API over the chained-egress path.
 * A genuinely fake value would instead be forwarded as-is and rejected
 * (401) one hop too early.
 */
async function seedFakeGithubCredential(): Promise<void> {
  if (await getGitCredentialByName(FAKE_GITHUB_CREDENTIAL_NAME)) return
  await insertGitCredential({ name: FAKE_GITHUB_CREDENTIAL_NAME, kind: 'https', secret: PLACEHOLDER_GH_TOKEN })
}

/**
 * Seed a fake OpenCode OpenRouter api-key credential. opencode is api-key only:
 * the stored key is the proxy placeholder (`yaac-ph-api-key`), which a parent
 * yaac's MITM proxy swaps for the real OpenRouter key on `openrouter.ai`. The
 * inner swap (placeholder → the seeded placeholder) is a no-op that keeps the
 * sentinel intact so the outer proxy does the real substitution — the same
 * chaining trick as the OAuth bundles above.
 */
async function seedFakeOpencodeOpenrouter(): Promise<void> {
  await saveOpencodeCredentialsFile({
    kind: 'api-key',
    provider: 'openrouter',
    savedAt: new Date().toISOString(),
    apiKey: PLACEHOLDER_API_KEY,
  })
}

/**
 * Seed a fake Pi OpenRouter api-key credential. Same shape and chaining trick
 * as `seedFakeOpencodeOpenrouter` — pi reads OpenRouter's key from
 * `OPENROUTER_API_KEY` and the proxy swaps the placeholder on `openrouter.ai`.
 */
async function seedFakePiOpenrouter(): Promise<void> {
  await savePiCredentialsFile({
    kind: 'api-key',
    provider: 'openrouter',
    savedAt: new Date().toISOString(),
    apiKey: PLACEHOLDER_API_KEY,
  })
}

/**
 * Whether this kind's store already holds a credential that is not a fake —
 * one a person signed in with. A fake over a fake is a re-seed and fine.
 * GitHub is never real here: its seed is a no-op when `fake-github` exists
 * and touches no other credential.
 */
async function holdsRealCredential(kind: FakeAuthKind): Promise<boolean> {
  switch (kind) {
    case 'claude-oauth': {
      const creds = await loadClaudeCredentialsFile()
      if (creds === null) return false
      return creds.kind === 'oauth'
        ? !isPlaceholderClaudeBundle(creds.claudeAiOauth)
        : creds.apiKey !== PLACEHOLDER_API_KEY
    }
    case 'opencode-openrouter': {
      const creds = await loadOpencodeCredentialsFile()
      return creds !== null && creds.apiKey !== PLACEHOLDER_API_KEY
    }
    case 'pi-openrouter': {
      const creds = await loadPiCredentialsFile()
      return creds !== null && creds.apiKey !== PLACEHOLDER_API_KEY
    }
    case 'github':
      return false
  }
}

/**
 * Seed fake credentials by their `yaac auth fake` kinds.
 *
 * Refuses (`CONFLICT`), seeding nothing, when any kind's store already holds
 * a REAL credential: the fakes exist for a store that starts empty (a fresh
 * inner data dir, an e2e server), and an install's real sign-in replaced by
 * sentinels would fan out to every project and authenticate nothing. There
 * is no force — `yaac auth clear` is what clears a real credential first.
 */
export async function seedFakeAuth(kinds: readonly FakeAuthKind[]): Promise<void> {
  const unique = [...new Set(kinds)]
  const real: FakeAuthKind[] = []
  for (const kind of unique) {
    if (await holdsRealCredential(kind)) real.push(kind)
  }
  if (real.length > 0) {
    throw new ServerError(
      'CONFLICT',
      `a real credential is already stored for ${real.join(', ')}; `
      + 'run "yaac auth clear" first to replace it with a fake one',
    )
  }
  for (const kind of unique) {
    switch (kind) {
      case 'claude-oauth':
        await seedFakeClaudeOAuth()
        break
      case 'opencode-openrouter':
        await seedFakeOpencodeOpenrouter()
        break
      case 'pi-openrouter':
        await seedFakePiOpenrouter()
        break
      case 'github':
        await seedFakeGithubCredential()
        break
    }
  }
}
