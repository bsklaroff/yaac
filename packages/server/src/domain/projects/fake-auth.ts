import {
  isPlaceholderClaudeBundle,
  writeProjectClaudePlaceholder,
  PLACEHOLDER_ACCESS_TOKEN,
  PLACEHOLDER_REFRESH_TOKEN,
  PLACEHOLDER_API_KEY,
  PLACEHOLDER_GH_TOKEN,
  PLACEHOLDER_OPENCODE_API_KEY,
  PLACEHOLDER_PI_API_KEY,
} from '@yaac/shared/tool-auth'
import { getGitCredentialByName, getToolCredential, insertGitCredential, listProjectRows, setToolCredential } from '#db'
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
 * Store a fake Claude OAuth credential for `owner` and write the placeholder
 * bundle into each of their projects, as a real OAuth login would.
 */
async function seedFakeClaudeOAuth(owner: string): Promise<void> {
  const bundle = buildFakeClaudeOAuthBundle()
  await setToolCredential(owner, 'claude', { kind: 'oauth', savedAt: new Date().toISOString(), claudeAiOauth: bundle })
  for (const project of await listProjectRows()) {
    if (project.owner === owner) await writeProjectClaudePlaceholder(project.id, bundle)
  }
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
async function seedFakeGithubCredential(owner: string): Promise<void> {
  if (await getGitCredentialByName(owner, FAKE_GITHUB_CREDENTIAL_NAME)) return
  await insertGitCredential({ owner, name: FAKE_GITHUB_CREDENTIAL_NAME, kind: 'https', secret: PLACEHOLDER_GH_TOKEN })
}

/**
 * Store a fake OpenCode OpenRouter api-key credential. The key is opencode's
 * proxy placeholder (`yaac-ph-opencode-api-key`); the inner proxy's swap
 * leaves it unchanged, and the outer proxy swaps in the real key on
 * `openrouter.ai`.
 */
async function seedFakeOpencodeOpenrouter(owner: string): Promise<void> {
  await setToolCredential(owner, 'opencode', {
    kind: 'api-key',
    provider: 'openrouter',
    savedAt: new Date().toISOString(),
    apiKey: PLACEHOLDER_OPENCODE_API_KEY,
  })
}

/** Store a fake Pi OpenRouter api-key credential, as for opencode. */
async function seedFakePiOpenrouter(owner: string): Promise<void> {
  await setToolCredential(owner, 'pi', {
    kind: 'api-key',
    provider: 'openrouter',
    savedAt: new Date().toISOString(),
    apiKey: PLACEHOLDER_PI_API_KEY,
  })
}

/**
 * Whether this kind's store holds a real (non-placeholder) credential.
 * GitHub never counts: its seed touches no other credential.
 */
async function holdsRealCredential(owner: string, kind: FakeAuthKind): Promise<boolean> {
  switch (kind) {
    case 'claude-oauth': {
      const creds = await getToolCredential(owner, 'claude')
      if (creds === null) return false
      return creds.kind === 'oauth'
        ? !isPlaceholderClaudeBundle(creds.claudeAiOauth)
        : creds.apiKey !== PLACEHOLDER_API_KEY
    }
    // The shared placeholder is what these fakes stored before each tool
    // had its own (docs/legacy-compat-shims.md).
    case 'opencode-openrouter': {
      const creds = await getToolCredential(owner, 'opencode')
      return creds !== null && ![PLACEHOLDER_OPENCODE_API_KEY, PLACEHOLDER_API_KEY].includes(creds.apiKey)
    }
    case 'pi-openrouter': {
      const creds = await getToolCredential(owner, 'pi')
      return creds !== null && ![PLACEHOLDER_PI_API_KEY, PLACEHOLDER_API_KEY].includes(creds.apiKey)
    }
    case 'github':
      return false
  }
}

/**
 * Seed `owner`'s fake credentials for the given `yaac auth fake` kinds.
 * Refuses (`CONFLICT`, seeding nothing) if any kind already has a real
 * credential of theirs, which placeholders would replace; `yaac auth clear`
 * it first.
 */
export async function seedFakeAuth(kinds: readonly FakeAuthKind[], owner: string): Promise<void> {
  const unique = [...new Set(kinds)]
  const real: FakeAuthKind[] = []
  for (const kind of unique) {
    if (await holdsRealCredential(owner, kind)) real.push(kind)
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
        await seedFakeClaudeOAuth(owner)
        break
      case 'opencode-openrouter':
        await seedFakeOpencodeOpenrouter(owner)
        break
      case 'pi-openrouter':
        await seedFakePiOpenrouter(owner)
        break
      case 'github':
        await seedFakeGithubCredential(owner)
        break
    }
  }
}
