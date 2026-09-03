import { and, eq } from 'drizzle-orm'
import { getDb } from './client'
import { projectEnvVars } from './schema'
import { secretConfig } from './secret-key'
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'
import { serverLog } from '#log'
import type { SecretProxyRule } from '@yaac/shared/types'

/**
 * A project's environment variables and proxied secrets.
 *
 * The one place a secret's value is sealed and opened. Everything above this
 * module hands over and receives plaintext, so no caller can forget to
 * encrypt and none has to remember to decrypt — the same reasoning that keeps
 * `getDb` off the barrel applies to the cipher.
 *
 * The cipher itself is better-auth's `symmetricEncrypt`/`symmetricDecrypt`:
 * XChaCha20-Poly1305 under a managed nonce, keyed by the SHA-256 of a secret
 * string, with a `$ba$<version>$` envelope that lets a key be rotated by
 * naming the superseded key beside the new one. Theirs rather than ours
 * because a cipher is exactly the thing not to write twice.
 *
 * A value that will not open is reported, not thrown: a retired key version
 * or a replaced key file leaves rows that are still listed (so the user can
 * see which secrets need re-entering) but resolve to nothing (so a worktree
 * launches without them rather than with an empty header, which fails
 * upstream as a bad credential rather than a missing one).
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

/** What a caller may write. `value` absent leaves the stored one alone,
 *  which is how a secret's rule is edited without re-entering the secret. */
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
 * Create or replace one variable, matched on (project, name).
 *
 * Writing a secret with no `value` keeps the sealed one — the rule is
 * editable without the secret having to travel again — but changing a plain
 * variable into a secret without one is refused by the caller above, since
 * there would be nothing to seal.
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
  // A secret's plaintext column is nulled and a plain one's sealed column is,
  // so the pair can never disagree about which holds the value — including
  // when a variable changes kind, which is exactly when a leftover would be a
  // plaintext copy of something now stored sealed.
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

/** Drop every variable of a project — project teardown, beside its rows. */
export async function deleteProjectEnvVars(projectSlug: string): Promise<void> {
  const db = await getDb()
  await db.delete(projectEnvVars).where(eq(projectEnvVars.projectSlug, projectSlug))
}
