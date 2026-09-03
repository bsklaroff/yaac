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
 * key material only as bytes it was handed, and a key that will not open is
 * reported rather than thrown — a broken row must not
 * take down the credential listing that is the only place the user can see
 * it needs replacing.
 */

export interface GitSshKeyRow {
  id: string
  pattern: string
  /** The PEM. Undefined when the sealed value will not open. */
  privateKey: string | undefined
  knownHostsEntry: string
  unreadable: boolean
}

async function toRow(r: typeof gitSshKeys.$inferSelect): Promise<GitSshKeyRow> {
  const base = { id: r.id, pattern: r.pattern, knownHostsEntry: r.knownHostsEntry }
  try {
    return {
      ...base,
      privateKey: await symmetricDecrypt({ key: await secretConfig(), data: r.sealedPrivateKey }),
      unreadable: false,
    }
  } catch (err) {
    serverLog(
      `[secrets] the ssh key for "${r.pattern}" could not be decrypted `
      + `(${err instanceof Error ? err.message : String(err)}); re-add it with \`yaac auth update\``,
    )
    return { ...base, privateKey: undefined, unreadable: true }
  }
}

/** Every stored key, oldest first (the order entries were added). */
export async function listGitSshKeys(): Promise<GitSshKeyRow[]> {
  const db = await getDb()
  const rows = await db.select().from(gitSshKeys).orderBy(gitSshKeys.createdAt)
  return await Promise.all(rows.map(toRow))
}

/** Add or replace the key for one repo pattern. */
export async function upsertGitSshKey(entry: {
  pattern: string
  privateKey: string
  knownHostsEntry: string
}): Promise<GitSshKeyRow> {
  const db = await getDb()
  const sealedPrivateKey = await symmetricEncrypt({ key: await secretConfig(), data: entry.privateKey })
  const rows = await db.insert(gitSshKeys)
    .values({
      pattern: entry.pattern,
      sealedPrivateKey,
      knownHostsEntry: entry.knownHostsEntry,
    })
    .onConflictDoUpdate({
      target: gitSshKeys.pattern,
      set: { sealedPrivateKey, knownHostsEntry: entry.knownHostsEntry },
    })
    .returning()
  return await toRow(rows[0])
}

/** Remove the key for a pattern. False when there was none. */
export async function deleteGitSshKey(pattern: string): Promise<boolean> {
  const db = await getDb()
  const rows = await db.delete(gitSshKeys)
    .where(eq(gitSshKeys.pattern, pattern))
    .returning({ id: gitSshKeys.id })
  return rows.length > 0
}

/** Drop every key — the wholesale credential replace, and `auth clear`. */
export async function deleteAllGitSshKeys(): Promise<void> {
  const db = await getDb()
  await db.delete(gitSshKeys)
}
