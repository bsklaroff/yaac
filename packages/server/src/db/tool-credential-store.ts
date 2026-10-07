import { and, eq } from 'drizzle-orm'
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'
import type { z } from 'zod'
import { getDb } from './client'
import { toolCredentials } from './schema'
import { secretConfig } from './secret-key'
import { serverLog } from '#log'
import {
  claudeCredentialsFileSchema,
  codexCredentialsFileSchema,
  opencodeCredentialsFileSchema,
  piCredentialsFileSchema,
  type AgentTool,
  type ToolCredentialBundle,
} from '@yaac/shared/types'

/**
 * Each user's agent-tool sign-ins, encrypted at rest like the git
 * credentials. A row that will not decrypt or fails its tool's schema is
 * logged and read as signed out, so the user is told which tool to sign in
 * again instead of the session failing later at an in-workspace login.
 */

/** One tool's stored credential, in that tool's shape. */
export type ToolCredential<T extends AgentTool> = NonNullable<ToolCredentialBundle[T]>

const schemas: { [T in AgentTool]: z.ZodType<ToolCredential<T>> } = {
  claude: claudeCredentialsFileSchema,
  codex: codexCredentialsFileSchema,
  opencode: opencodeCredentialsFileSchema,
  pi: piCredentialsFileSchema,
}

const EMPTY_BUNDLE: ToolCredentialBundle = { claude: null, codex: null, opencode: null, pi: null }

async function open<T extends AgentTool>(tool: T, sealed: string): Promise<ToolCredential<T> | null> {
  let reason: string
  try {
    const result = schemas[tool].safeParse(JSON.parse(await symmetricDecrypt({ key: await secretConfig(), data: sealed })))
    if (result.success) return result.data
    reason = result.error.issues[0]?.message ?? 'invalid'
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err)
  }
  serverLog(`[secrets] ignoring the stored ${tool} credential (${reason}); sign in to ${tool} again`)
  return null
}

/** A user's credential for one tool; null when signed out. */
export async function getToolCredential<T extends AgentTool>(
  owner: string,
  tool: T,
): Promise<ToolCredential<T> | null> {
  const db = await getDb()
  const [row] = await db.select({ sealed: toolCredentials.sealedCredential }).from(toolCredentials)
    .where(and(eq(toolCredentials.owner, owner), eq(toolCredentials.tool, tool)))
  return row ? open(tool, row.sealed) : null
}

/** Store a user's credential for one tool, replacing any. */
export async function setToolCredential<T extends AgentTool>(
  owner: string,
  tool: T,
  credential: ToolCredential<T>,
): Promise<void> {
  const db = await getDb()
  const sealedCredential = await symmetricEncrypt({ key: await secretConfig(), data: JSON.stringify(credential) })
  await db.insert(toolCredentials).values({ owner, tool, sealedCredential })
    .onConflictDoUpdate({
      target: [toolCredentials.owner, toolCredentials.tool],
      set: { sealedCredential, updatedAt: new Date() },
    })
}

/** Remove a user's credential for one tool. True if there was one. */
export async function deleteToolCredential(owner: string, tool: AgentTool): Promise<boolean> {
  const db = await getDb()
  const rows = await db.delete(toolCredentials)
    .where(and(eq(toolCredentials.owner, owner), eq(toolCredentials.tool, tool)))
    .returning({ id: toolCredentials.id })
  return rows.length > 0
}

/** Every user's credentials, keyed by owner; a user with none is absent. */
export async function listToolCredentials(): Promise<Record<string, ToolCredentialBundle>> {
  const db = await getDb()
  const rows = await db.select().from(toolCredentials)
  const out: Record<string, ToolCredentialBundle> = {}
  for (const row of rows) {
    const bundle = out[row.owner] ??= { ...EMPTY_BUNDLE }
    // Assigning through the union key needs the per-tool pairing TS can't see.
    ;(bundle as Record<AgentTool, unknown>)[row.tool] = await open(row.tool, row.sealedCredential)
  }
  return out
}
