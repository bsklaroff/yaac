import { eq } from 'drizzle-orm'
import { getDb } from './client'
import { gitCredentials, legacyGitSshKeys, projects } from './schema'
import { secretConfig } from './secret-key'
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'
import { ServerError } from '@yaac/shared/errors'
import { serverLog } from '#log'
import { notifyWorktreeListChanged } from '#notify'
import { withKeyComment } from '#lib/ssh-key'

/**
 * The named git credentials, sealed at rest (docs/git-credentials.md).
 *
 * Same discipline as the env store, and the same cipher (better-auth's
 * `symmetricEncrypt`): sealing happens here, so every caller above handles
 * a secret only as a value it was handed. A row is returned WITHOUT its
 * secret opened — the public key is a plain column, and the agent's
 * identity answer works from it alone — and `openSecret` is the one door.
 * A secret that will not open is reported rather than thrown, so a broken
 * row cannot take down the listing that is the one place the user can see
 * it needs replacing.
 */

export type GitCredentialKind = 'https' | 'ssh'

export interface GitCredentialRow {
  id: string
  name: string
  kind: GitCredentialKind
  /** ssh only: the public half, one OpenSSH line. */
  publicKey: string | null
  /** The token, or the ssh key's ed25519 seed as base64, decrypted on call.
   *  Undefined when the sealed value will not open (logged). */
  openSecret: () => Promise<string | undefined>
}

function toRow(r: typeof gitCredentials.$inferSelect): GitCredentialRow {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind === 'ssh' ? 'ssh' : 'https',
    publicKey: r.publicKey,
    openSecret: async () => {
      try {
        return await symmetricDecrypt({ key: await secretConfig(), data: r.sealedSecret })
      } catch (err) {
        serverLog(
          `[secrets] the git credential "${r.name}" could not be decrypted `
          + `(${err instanceof Error ? err.message : String(err)}); replace it in Settings`,
        )
        return undefined
      }
    },
  }
}

function nameTaken(name: string): ServerError {
  return new ServerError('CONFLICT', `A git credential named "${name}" already exists.`)
}

/** Every stored credential, oldest first. */
export async function listGitCredentials(): Promise<GitCredentialRow[]> {
  const db = await getDb()
  const rows = await db.select().from(gitCredentials).orderBy(gitCredentials.createdAt)
  return rows.map(toRow)
}

export async function getGitCredential(id: string): Promise<GitCredentialRow | undefined> {
  const db = await getDb()
  const rows = await db.select().from(gitCredentials).where(eq(gitCredentials.id, id))
  return rows[0] && toRow(rows[0])
}

export async function getGitCredentialByName(name: string): Promise<GitCredentialRow | undefined> {
  const db = await getDb()
  const rows = await db.select().from(gitCredentials).where(eq(gitCredentials.name, name))
  return rows[0] && toRow(rows[0])
}

/** Store a new credential. A name already in use is a CONFLICT. */
export async function insertGitCredential(entry: {
  name: string
  kind: GitCredentialKind
  secret: string
  publicKey?: string
}): Promise<GitCredentialRow> {
  const db = await getDb()
  const sealedSecret = await symmetricEncrypt({ key: await secretConfig(), data: entry.secret })
  const rows = await db.insert(gitCredentials)
    .values({ name: entry.name, kind: entry.kind, sealedSecret, publicKey: entry.publicKey ?? null })
    .onConflictDoNothing({ target: gitCredentials.name })
    .returning()
  if (!rows[0]) throw nameTaken(entry.name)
  return toRow(rows[0])
}

/** Rename a credential (and, for a key, the public line whose comment
 *  carries the name). False when there is no such credential. */
export async function renameGitCredential(
  id: string,
  name: string,
  publicKey: string | null,
): Promise<boolean> {
  const db = await getDb()
  const clash = await db.select({ id: gitCredentials.id }).from(gitCredentials)
    .where(eq(gitCredentials.name, name))
  if (clash[0] && clash[0].id !== id) throw nameTaken(name)
  const rows = await db.update(gitCredentials).set({ name, publicKey })
    .where(eq(gitCredentials.id, id)).returning({ id: gitCredentials.id })
  // The listing names each project's credential.
  notifyWorktreeListChanged()
  return rows.length > 0
}

/**
 * Remove a credential, leaving the projects that used it with none — the
 * host key their assignment trusted goes with it. Deliberately not refused
 * while in use: a leaked credential has to be removable at once. False when
 * there was no such credential.
 */
export async function deleteGitCredential(id: string): Promise<boolean> {
  const db = await getDb()
  const deleted = await db.transaction(async (tx) => {
    await tx.update(projects).set({ gitCredentialId: null, knownHostsEntry: null })
      .where(eq(projects.gitCredentialId, id))
    const rows = await tx.delete(gitCredentials).where(eq(gitCredentials.id, id))
      .returning({ id: gitCredentials.id })
    return rows.length > 0
  })
  // The listing names each project's credential.
  notifyWorktreeListChanged()
  return deleted
}

/**
 * Replace a credential's secret with a new one: a new row under the same
 * name, every project moved onto it with the host key it already trusted
 * (the host has not changed, only the key), and the old row deleted — in
 * one transaction, so no project is ever without a credential in between.
 * A new row rather than an update, so nothing holding the old id can go on
 * using what replaced it unawares. Undefined when there is no such
 * credential.
 */
export async function replaceGitCredential(
  id: string,
  next: { secret: string; publicKey?: string },
): Promise<GitCredentialRow | undefined> {
  const db = await getDb()
  const sealedSecret = await symmetricEncrypt({ key: await secretConfig(), data: next.secret })
  const row = await db.transaction(async (tx) => {
    const [old] = await tx.select().from(gitCredentials).where(eq(gitCredentials.id, id))
    if (!old) return undefined
    const [fresh] = await tx.insert(gitCredentials).values({
      name: `${old.name} (replacing ${old.id})`,
      kind: old.kind,
      sealedSecret,
      publicKey: next.publicKey ?? null,
    }).returning()
    await tx.update(projects).set({ gitCredentialId: fresh.id }).where(eq(projects.gitCredentialId, id))
    await tx.delete(gitCredentials).where(eq(gitCredentials.id, id))
    const [renamed] = await tx.update(gitCredentials).set({ name: old.name })
      .where(eq(gitCredentials.id, fresh.id)).returning()
    return renamed
  })
  notifyWorktreeListChanged()
  return row && toRow(row)
}

/**
 * LEGACY (docs/legacy-compat-shims.md, "Pattern-matched git credentials"):
 * turn every per-pattern SSH key an older server generated into a named
 * credential — the sealed seed copied as it is, named for its pattern —
 * and hand back what the importer needs to assign it. Idempotent: a row
 * whose name already exists is looked up rather than inserted again.
 */
export async function importLegacyGitSshKeys(): Promise<Array<{
  id: string
  pattern: string
  knownHostsEntry: string
}>> {
  const db = await getDb()
  const legacy = await db.select().from(legacyGitSshKeys).orderBy(legacyGitSshKeys.createdAt)
  const out: Array<{ id: string; pattern: string; knownHostsEntry: string }> = []
  for (const k of legacy) {
    const name = `${k.pattern} (ssh key)`
    await db.insert(gitCredentials).values({
      name,
      kind: 'ssh',
      sealedSecret: k.sealedPrivateKey,
      publicKey: withKeyComment(k.publicKey, name),
    }).onConflictDoNothing({ target: gitCredentials.name })
    const [row] = await db.select({ id: gitCredentials.id }).from(gitCredentials)
      .where(eq(gitCredentials.name, name))
    out.push({ id: row.id, pattern: k.pattern, knownHostsEntry: k.knownHostsEntry })
  }
  return out
}

/** LEGACY: empty the old key table once its rows are imported and assigned. */
export async function deleteLegacyGitSshKeys(): Promise<void> {
  const db = await getDb()
  await db.delete(legacyGitSshKeys)
}
