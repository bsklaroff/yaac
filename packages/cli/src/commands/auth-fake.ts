import { getApiClient } from '@yaac/shared/server-api'
import type { FakeAuthKind } from '@yaac/shared/types'

/** Confirmation line printed for each seeded kind. */
const SEEDED_MESSAGE: Record<FakeAuthKind, string> = {
  'claude-oauth': 'Seeded fake Claude OAuth credentials (proxy placeholder bundle).',
  'opencode-openrouter': 'Seeded fake OpenCode OpenRouter api-key (proxy placeholder).',
  'pi-openrouter': 'Seeded fake Pi OpenRouter api-key (proxy placeholder).',
  'github': 'Seeded fake GitHub credential for pattern "github.com/*".',
}

/**
 * Seed fake credentials into the data dir for local/dev testing — most useful
 * for yaac-in-yaac, where the inner yaac needs a credential it can chain
 * through the parent's MITM proxy. The server owns the write; the server and
 * proxy then read the seeded files fresh on the next session. Accepts one or
 * more kinds in a single call. The CLI's Argument.choices() rejects unknown
 * kinds before this runs, and the server route zod-validates the body.
 */
export async function authFake(kinds: FakeAuthKind[]): Promise<void> {
  // De-dupe so a repeated kind prints (and seeds) once; the server dedupes too.
  const unique = [...new Set(kinds)]
  const client = getApiClient()
  await client.auth.fake.$post({ json: { kinds: unique } })
  for (const kind of unique) {
    console.log(SEEDED_MESSAGE[kind])
  }
}
