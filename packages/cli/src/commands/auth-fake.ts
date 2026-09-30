import { getApiClient } from '@yaac/shared/server-api'
import type { FakeAuthKind } from '@yaac/shared/types'

/** Confirmation line printed for each seeded kind. */
const SEEDED_MESSAGE: Record<FakeAuthKind, string> = {
  'claude-oauth': 'Seeded fake Claude OAuth credentials (proxy placeholder bundle).',
  'opencode-openrouter': 'Seeded fake OpenCode OpenRouter api-key (proxy placeholder).',
  'pi-openrouter': 'Seeded fake Pi OpenRouter api-key (proxy placeholder).',
  'github': 'Seeded fake GitHub git credential "fake-github" (proxy placeholder).',
}

/**
 * Ask the server to seed fake credentials for local/dev testing. Most useful
 * for yaac-in-yaac, where the inner yaac needs a credential it can pass
 * through the outer yaac's MITM proxy. Repeated kinds are seeded and printed
 * once.
 */
export async function authFake(kinds: FakeAuthKind[]): Promise<void> {
  const unique = [...new Set(kinds)]
  const client = getApiClient()
  await client.auth.fake.$post({ json: { kinds: unique } })
  for (const kind of unique) {
    console.log(SEEDED_MESSAGE[kind])
  }
}
