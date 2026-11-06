import { and, eq } from 'drizzle-orm'
import { getDb } from './client'
import { projectRunSecrets } from './schema'
import { secretConfig } from './secret-key'
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'
import { serverLog } from '#lib/log'

/**
 * A project's run secrets (docs/project-config.md "Run secrets"), sealed
 * with the same cipher and key as its proxied secrets
 * (project-env-store.ts). A value that will not open is logged and read as
 * undefined, so the user can see the row and re-enter it.
 */

export interface RunSecretRow {
  id: string
  projectId: string
  name: string
  /** Undefined when the sealed value will not open. */
  value: string | undefined
}

type Selected = typeof projectRunSecrets.$inferSelect

async function toRow(r: Selected): Promise<RunSecretRow> {
  let value: string | undefined
  try {
    value = await symmetricDecrypt({ key: await secretConfig(), data: r.sealedValue })
  } catch (err) {
    serverLog(`[secrets] run secret ${r.projectId}/${r.name} could not be decrypted `
      + `(${err instanceof Error ? err.message : String(err)}); re-enter it in project settings`)
  }
  return { id: r.id, projectId: r.projectId, name: r.name, value }
}

/** A project's run secrets in name order. */
export async function listRunSecrets(projectId: string): Promise<RunSecretRow[]> {
  const db = await getDb()
  const rows = await db.select().from(projectRunSecrets)
    .where(eq(projectRunSecrets.projectId, projectId))
    .orderBy(projectRunSecrets.name)
  return await Promise.all(rows.map(toRow))
}

/** Create or replace one run secret, matched on (project, name). */
export async function upsertRunSecret(projectId: string, input: { name: string; value: string }): Promise<RunSecretRow> {
  const db = await getDb()
  const sealedValue = await symmetricEncrypt({ key: await secretConfig(), data: input.value })
  const rows = await db.insert(projectRunSecrets)
    .values({ projectId, name: input.name, sealedValue })
    .onConflictDoUpdate({
      target: [projectRunSecrets.projectId, projectRunSecrets.name],
      set: { sealedValue, updatedAt: new Date() },
    })
    .returning()
  return await toRow(rows[0])
}

/** Remove one run secret by id. False when the id is not this project's. */
export async function deleteRunSecret(projectId: string, id: string): Promise<boolean> {
  const db = await getDb()
  const rows = await db.delete(projectRunSecrets)
    .where(and(eq(projectRunSecrets.projectId, projectId), eq(projectRunSecrets.id, id)))
    .returning({ id: projectRunSecrets.id })
  return rows.length > 0
}

/** Delete every run secret of a project, on project removal. */
export async function deleteProjectRunSecrets(projectId: string): Promise<void> {
  const db = await getDb()
  await db.delete(projectRunSecrets).where(eq(projectRunSecrets.projectId, projectId))
}
