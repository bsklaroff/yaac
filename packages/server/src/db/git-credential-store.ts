import { eq } from 'drizzle-orm'
import { getDb } from './client'
import { gitCredentials, projects } from './schema'
import { secretConfig } from './secret-key'
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'
import { ServerError } from '@yaac/shared/errors'
import { serverLog } from '#log'
import { notifyWorkspaceListChanged } from '#notify'

/**
 * Named git credentials, encrypted at rest (docs/git-credentials.md) with the
 * same cipher as the env store. Rows are returned with the secret still
 * encrypted; `openSecret` decrypts on demand. A secret that fails to decrypt
 * is logged, not thrown, so the listing still shows the user which one to
 * replace.
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

/** Rename a credential, and for an ssh key its public line, whose comment
 *  carries the name. False when there is no such credential. */
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
  notifyWorkspaceListChanged()
  return rows.length > 0
}

/**
 * Remove a credential, unassigning it (and its trusted host key) from every
 * project. Allowed while in use, so a leaked credential can be removed at
 * once. False when there was no such credential.
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
  notifyWorkspaceListChanged()
  return deleted
}

/**
 * Replace a credential's secret. In one transaction: insert a new row under
 * the same name, move every project onto it (keeping its trusted host key),
 * and delete the old row. A new id means nothing holding the old id silently
 * uses the new secret. Undefined when there is no such credential.
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
  notifyWorkspaceListChanged()
  return row && toRow(row)
}
