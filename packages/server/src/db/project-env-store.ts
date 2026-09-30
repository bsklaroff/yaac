import { and, eq } from 'drizzle-orm'
import { getDb } from './client'
import { projectEnvVars } from './schema'
import { secretConfig } from './secret-key'
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'
import { serverLog } from '#log'
import type { SecretProxyRule } from '@yaac/shared/types'

/**
 * A project's environment variables and proxied secrets. Secret values are
 * encrypted and decrypted only here, so callers deal in plaintext and can't
 * forget either step.
 *
 * The cipher is better-auth's `symmetricEncrypt`/`symmetricDecrypt`
 * (XChaCha20-Poly1305, keyed by the SHA-256 of a secret string, with a
 * versioned envelope that supports key rotation).
 *
 * A value that fails to decrypt (retired or replaced key) is logged, not
 * thrown. The row is still listed so the user can re-enter it, but has no
 * value, so a workspace launches without it rather than with an empty
 * header.
 */

/** One row, with a secret's value already opened. */
export interface ProjectEnvVarRow {
  id: string
  projectSlug: string
  name: string
  /** Plaintext either way. Undefined for a secret whose value will not open. */
  value: string | undefined
  secret: boolean
  rule: SecretProxyRule | undefined
  /** True when this row holds a sealed value that failed to open. */
  unreadable: boolean
}

/** What a caller may write. Omitting `value` keeps the stored one, so a
 *  secret's rule can be edited without re-entering the secret. */
export interface ProjectEnvVarInput {
  name: string
  value?: string
  secret: boolean
  rule?: SecretProxyRule
}

type Selected = typeof projectEnvVars.$inferSelect

async function toRow(r: Selected): Promise<ProjectEnvVarRow> {
  const rule = (r.rule ?? undefined) as SecretProxyRule | undefined
  const base = {
    id: r.id,
    projectSlug: r.projectSlug,
    name: r.name,
    secret: r.secret,
    rule,
  }
  if (!r.secret || r.sealedValue === null) {
    return { ...base, value: r.value ?? undefined, unreadable: false }
  }
  try {
    return { ...base, value: await symmetricDecrypt({ key: await secretConfig(), data: r.sealedValue }), unreadable: false }
  } catch (err) {
    serverLog(
      `[secrets] ${r.projectSlug}/${r.name} could not be decrypted `
      + `(${err instanceof Error ? err.message : String(err)}); re-enter it in project settings`,
    )
    return { ...base, value: undefined, unreadable: true }
  }
}

/** Every variable of a project, plain and secret, in name order. */
export async function listProjectEnvVars(projectSlug: string): Promise<ProjectEnvVarRow[]> {
  const db = await getDb()
  const rows = await db.select().from(projectEnvVars)
    .where(eq(projectEnvVars.projectSlug, projectSlug))
    .orderBy(projectEnvVars.name)
  return await Promise.all(rows.map(toRow))
}

/**
 * Create or replace one variable, matched on (project, name). A secret
 * written without `value` keeps its encrypted value. (The caller refuses
 * turning a plain variable into a secret without a value.)
 */
export async function upsertProjectEnvVar(
  projectSlug: string,
  input: ProjectEnvVarInput,
): Promise<ProjectEnvVarRow> {
  const db = await getDb()
  const sealed = input.secret && input.value !== undefined
    ? await symmetricEncrypt({ key: await secretConfig(), data: input.value })
    : undefined
  const shared = {
    secret: input.secret,
    rule: input.rule ?? null,
    updatedAt: new Date(),
  }
  // Null the unused column (plaintext for a secret, encrypted for a plain
  // var), so a variable that changes kind never leaves a plaintext copy.
  const written = input.secret
    ? { value: null, ...(sealed !== undefined ? { sealedValue: sealed } : {}) }
    : { value: input.value ?? '', sealedValue: null }
  const rows = await db.insert(projectEnvVars)
    .values({
      projectSlug,
      name: input.name,
      value: input.secret ? null : input.value ?? '',
      sealedValue: sealed ?? null,
      ...shared,
    })
    .onConflictDoUpdate({
      target: [projectEnvVars.projectSlug, projectEnvVars.name],
      set: { ...written, ...shared },
    })
    .returning()
  return await toRow(rows[0])
}

/** Remove one variable by id. False when the id is not this project's. */
export async function deleteProjectEnvVar(projectSlug: string, id: string): Promise<boolean> {
  const db = await getDb()
  const rows = await db.delete(projectEnvVars)
    .where(and(eq(projectEnvVars.projectSlug, projectSlug), eq(projectEnvVars.id, id)))
    .returning({ id: projectEnvVars.id })
  return rows.length > 0
}

/** Delete every variable of a project, on project removal. */
export async function deleteProjectEnvVars(projectSlug: string): Promise<void> {
  const db = await getDb()
  await db.delete(projectEnvVars).where(eq(projectEnvVars.projectSlug, projectSlug))
}
