import { eq } from 'drizzle-orm'
import { getDb } from './client'
import { gitSshKeys } from './schema'
import { secretConfig } from './secret-key'
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'
import { serverLog } from '#log'

/**
 * The SSH keys git authenticates with, sealed at rest.
 *
 * Same discipline as the env store, and the same cipher (better-auth's
 * `symmetricEncrypt`): sealing happens here, so every caller above handles
 * key material only as bytes it was handed. A row is returned WITHOUT its
 * seed opened — the public half and the host key are plain columns, and
 * the agent's identity answer and the host-key lookup work from those
 * alone — and `openSeed` is the one door: the sign path, a launch handing
 * the key to a worktree's own agent, a credential resolve checking the
 * match is usable, and the user-facing listing, which opens each row to
 * say whether it still is. A seed that will not open is reported rather
 * than thrown, so a broken row cannot take down that listing — the one
 * place the user can see it needs regenerating.
 */

export interface GitSshKeyRow {
  id: string
  pattern: string
  /** The public half, one OpenSSH line. */
  publicKey: string
  knownHostsEntry: string
  /** The ed25519 seed, decrypted on call. Undefined when the sealed value
   *  will not open (logged). */
  openSeed: () => Promise<Buffer | undefined>
}

function toRow(r: typeof gitSshKeys.$inferSelect): GitSshKeyRow {
  return {
    id: r.id,
    pattern: r.pattern,
    publicKey: r.publicKey,
    knownHostsEntry: r.knownHostsEntry,
    openSeed: async () => {
      try {
        const opened = await symmetricDecrypt({ key: await secretConfig(), data: r.sealedPrivateKey })
        return Buffer.from(opened, 'base64')
      } catch (err) {
        serverLog(
          `[secrets] the ssh key for "${r.pattern}" could not be decrypted `
          + `(${err instanceof Error ? err.message : String(err)}); generate a new one with \`yaac auth update\``,
        )
        return undefined
      }
    },
  }
}

/** Every stored key, oldest first (the order entries were added). */
export async function listGitSshKeys(): Promise<GitSshKeyRow[]> {
  const db = await getDb()
  const rows = await db.select().from(gitSshKeys).orderBy(gitSshKeys.createdAt)
  return rows.map(toRow)
}

/** Add or replace the key for one repo pattern. */
export async function upsertGitSshKey(entry: {
  pattern: string
  seed: Buffer
  publicKey: string
  knownHostsEntry: string
}): Promise<GitSshKeyRow> {
  const db = await getDb()
  const sealedPrivateKey = await symmetricEncrypt({
    key: await secretConfig(),
    data: entry.seed.toString('base64'),
  })
  const values = { sealedPrivateKey, publicKey: entry.publicKey, knownHostsEntry: entry.knownHostsEntry }
  const rows = await db.insert(gitSshKeys)
    .values({ pattern: entry.pattern, ...values })
    .onConflictDoUpdate({ target: gitSshKeys.pattern, set: values })
    .returning()
  return toRow(rows[0])
}

/** Remove the key for a pattern. False when there was none. */
export async function deleteGitSshKey(pattern: string): Promise<boolean> {
  const db = await getDb()
  const rows = await db.delete(gitSshKeys)
    .where(eq(gitSshKeys.pattern, pattern))
    .returning({ id: gitSshKeys.id })
  return rows.length > 0
}

/** Drop every key — `auth clear`. */
export async function deleteAllGitSshKeys(): Promise<void> {
  const db = await getDb()
  await db.delete(gitSshKeys)
}
