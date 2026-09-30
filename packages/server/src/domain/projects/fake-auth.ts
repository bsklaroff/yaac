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

/** The scopes of a real Claude Code OAuth bundle, so the fake looks
 *  plausible. */
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
 * A fake Claude OAuth bundle whose tokens are the proxy placeholders
 * (`yaac-ph-access` / `yaac-ph-refresh`). An outer yaac's proxy swaps them for
 * the real credential, which is how yaac-in-yaac authenticates. It must be
 * OAuth, since an api-key swap can't chain through an OAuth outer proxy.
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
 * Store a fake Claude OAuth credential and write the placeholder bundle into
 * every existing project, as a real OAuth login would.
 */
async function seedFakeClaudeOAuth(): Promise<void> {
  const bundle = buildFakeClaudeOAuthBundle()
  await saveClaudeOAuthBundle(bundle)
  await fanOutClaudePlaceholders(bundle)
}

// There is no `codex-oauth` fake: codex sends a `ChatGPT-Account-Id` header
// the proxy doesn't swap, so a fake account id would reach OpenAI alongside
// the outer install's real token.

/**
 * Create the `fake-github` HTTPS credential unless it exists, for `yaac
 * project add <url> fake-github`. Its token is the proxy placeholder
 * (`yaac-ph-gh-token`), which an outer yaac's proxy swaps for the real
 * GitHub token.
 */
async function seedFakeGithubCredential(): Promise<void> {
  if (await getGitCredentialByName(FAKE_GITHUB_CREDENTIAL_NAME)) return
  await insertGitCredential({ name: FAKE_GITHUB_CREDENTIAL_NAME, kind: 'https', secret: PLACEHOLDER_GH_TOKEN })
}

/**
 * Store a fake OpenCode OpenRouter api-key credential. The key is the proxy
 * placeholder (`yaac-ph-api-key`); the inner proxy's swap leaves it
 * unchanged, and the outer proxy swaps in the real key on `openrouter.ai`.
 */
async function seedFakeOpencodeOpenrouter(): Promise<void> {
  await saveOpencodeCredentialsFile({
    kind: 'api-key',
    provider: 'openrouter',
    savedAt: new Date().toISOString(),
    apiKey: PLACEHOLDER_API_KEY,
  })
}

/** Store a fake Pi OpenRouter api-key credential, as for opencode. */
async function seedFakePiOpenrouter(): Promise<void> {
  await savePiCredentialsFile({
    kind: 'api-key',
    provider: 'openrouter',
    savedAt: new Date().toISOString(),
    apiKey: PLACEHOLDER_API_KEY,
  })
}

/**
 * Whether this kind's store holds a real (non-placeholder) credential.
 * GitHub never counts: its seed touches no other credential.
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
 * Seed fake credentials for the given `yaac auth fake` kinds. Refuses
 * (`CONFLICT`, seeding nothing) if any kind already has a real credential,
 * which placeholders would replace everywhere; `yaac auth clear` it first.
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
