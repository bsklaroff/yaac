import { and, eq, sql } from 'drizzle-orm'
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
  siteIds: string[]
  routineIds: string[]
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
  return { id: r.id, projectId: r.projectId, name: r.name, value, siteIds: r.siteIds, routineIds: r.routineIds }
}

/** A project's run secrets in name order. */
export async function listRunSecrets(projectId: string): Promise<RunSecretRow[]> {
  const db = await getDb()
  const rows = await db.select().from(projectRunSecrets)
    .where(eq(projectRunSecrets.projectId, projectId))
    .orderBy(projectRunSecrets.name)
  return await Promise.all(rows.map(toRow))
}

/**
 * Create or replace one run secret, matched on (project, name). Without
 * `value` only its targets change, and a secret that does not exist yet
 * answers undefined.
 */
export async function upsertRunSecret(projectId: string, input: {
  name: string
  value?: string
  siteIds: string[]
  routineIds: string[]
}): Promise<RunSecretRow | undefined> {
  const db = await getDb()
  const targets = { siteIds: input.siteIds, routineIds: input.routineIds, updatedAt: new Date() }
  if (input.value === undefined) {
    const rows = await db.update(projectRunSecrets).set(targets)
      .where(and(eq(projectRunSecrets.projectId, projectId), eq(projectRunSecrets.name, input.name)))
      .returning()
    return rows[0] && await toRow(rows[0])
  }
  const sealedValue = await symmetricEncrypt({ key: await secretConfig(), data: input.value })
  const rows = await db.insert(projectRunSecrets)
    .values({ projectId, name: input.name, sealedValue, ...targets })
    .onConflictDoUpdate({
      target: [projectRunSecrets.projectId, projectRunSecrets.name],
      set: { sealedValue, ...targets },
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

/** Drop a deleted site or routine from every run secret's targets. */
export async function forgetRunSecretTarget(id: string): Promise<void> {
  const db = await getDb()
  await db.update(projectRunSecrets).set({
    siteIds: sql`array_remove(${projectRunSecrets.siteIds}, ${id}::uuid)`,
    routineIds: sql`array_remove(${projectRunSecrets.routineIds}, ${id}::uuid)`,
  })
}
