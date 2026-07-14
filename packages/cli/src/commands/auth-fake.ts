import { getRpcClient } from '@yaac/shared/server-client'

/** Valid `<kind>` arguments for `yaac auth fake`. */
export const FAKE_AUTH_KINDS = ['claude-oauth', 'github'] as const
export type FakeAuthKind = (typeof FAKE_AUTH_KINDS)[number]

/**
 * Seed fake credentials into the data dir for local/dev testing — most useful
 * for yaac-in-yaac, where the inner yaac needs a credential it can chain
 * through the parent's MITM proxy. The server owns the write; the server and
 * proxy then read the seeded files fresh on the next session. The CLI's
 * Argument.choices() rejects unknown kinds before this runs, and the server
 * route zod-validates the body.
 */
export async function authFake(kind: FakeAuthKind): Promise<void> {
  const client = await getRpcClient()
  await client.auth.fake.$post({ json: { kind } })
  if (kind === 'claude-oauth') {
    console.log('Seeded fake Claude OAuth credentials (proxy placeholder bundle).')
  } else {
    console.log('Seeded fake GitHub credential for pattern "github.com/*".')
  }
}
