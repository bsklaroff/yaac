import { and, eq } from 'drizzle-orm'
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'
import { ServerError } from '@yaac/shared/errors'
import type { EndpointModel } from '@yaac/shared/tool-providers'
import { getDb } from './client'
import { customEndpoints } from './schema'
import { secretConfig } from './secret-key'
import { serverLog } from '#lib/log'

/**
 * Each user's custom endpoints (docs/custom-endpoints.md), their keys
 * encrypted at rest like the git credentials. A key that will not decrypt
 * is logged and read as absent, so the endpoint still lists and the user
 * can enter it again.
 */

export interface CustomEndpointRow {
  id: string
  owner: string
  name: string
  baseUrl: string
  /** '' when it takes none, or when the sealed key will not open. */
  apiKey: string
  models: EndpointModel[]
}

async function toRow(r: typeof customEndpoints.$inferSelect): Promise<CustomEndpointRow> {
  let apiKey = ''
  if (r.sealedApiKey !== '') {
    try {
      apiKey = await symmetricDecrypt({ key: await secretConfig(), data: r.sealedApiKey })
    } catch (err) {
      serverLog(
        `[secrets] the key of the custom endpoint "${r.name}" could not be decrypted `
        + `(${err instanceof Error ? err.message : String(err)}); enter it again in Settings`,
      )
    }
  }
  return { id: r.id, owner: r.owner, name: r.name, baseUrl: r.baseUrl, apiKey, models: r.models }
}

async function seal(apiKey: string): Promise<string> {
  return apiKey === '' ? '' : symmetricEncrypt({ key: await secretConfig(), data: apiKey })
}

function nameTaken(name: string): ServerError {
  return new ServerError('CONFLICT', `A custom endpoint named "${name}" already exists.`)
}

/** Every stored endpoint, or only one owner's, oldest first. */
export async function listCustomEndpoints(owner?: string): Promise<CustomEndpointRow[]> {
  const db = await getDb()
  const rows = await db.select().from(customEndpoints)
    .where(owner === undefined ? undefined : eq(customEndpoints.owner, owner))
    .orderBy(customEndpoints.createdAt)
  return Promise.all(rows.map(toRow))
}

export async function getCustomEndpoint(id: string): Promise<CustomEndpointRow | undefined> {
  const db = await getDb()
  const [row] = await db.select().from(customEndpoints).where(eq(customEndpoints.id, id))
  return row && toRow(row)
}

/** Store a new endpoint. A name the owner already uses is a CONFLICT. */
export async function insertCustomEndpoint(entry: Omit<CustomEndpointRow, 'id'>): Promise<CustomEndpointRow> {
  const db = await getDb()
  const rows = await db.insert(customEndpoints)
    .values({
      owner: entry.owner, name: entry.name, baseUrl: entry.baseUrl,
      sealedApiKey: await seal(entry.apiKey), models: entry.models,
    })
    .onConflictDoNothing({ target: [customEndpoints.owner, customEndpoints.name] })
    .returning()
  if (!rows[0]) throw nameTaken(entry.name)
  return toRow(rows[0])
}

/** Change an endpoint's fields; those absent are kept. A name the owner
 *  already uses is a CONFLICT. Undefined when there is no such endpoint. */
export async function updateCustomEndpoint(
  id: string,
  patch: Partial<Pick<CustomEndpointRow, 'name' | 'baseUrl' | 'apiKey' | 'models'>>,
): Promise<CustomEndpointRow | undefined> {
  const db = await getDb()
  const [current] = await db.select({ owner: customEndpoints.owner }).from(customEndpoints)
    .where(eq(customEndpoints.id, id))
  if (!current) return undefined
  if (patch.name !== undefined) {
    const [clash] = await db.select({ id: customEndpoints.id }).from(customEndpoints)
      .where(and(eq(customEndpoints.owner, current.owner), eq(customEndpoints.name, patch.name)))
    if (clash && clash.id !== id) throw nameTaken(patch.name)
  }
  const [row] = await db.update(customEndpoints).set({
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
    ...(patch.apiKey !== undefined ? { sealedApiKey: await seal(patch.apiKey) } : {}),
    ...(patch.models !== undefined ? { models: patch.models } : {}),
  }).where(eq(customEndpoints.id, id)).returning()
  return row && toRow(row)
}

/** Remove an endpoint. False when there was no such endpoint. */
export async function deleteCustomEndpoint(id: string): Promise<boolean> {
  const db = await getDb()
  const rows = await db.delete(customEndpoints).where(eq(customEndpoints.id, id))
    .returning({ id: customEndpoints.id })
  return rows.length > 0
}
