import {
  deleteProjectEnvVar,
  listProjectEnvVars,
  upsertProjectEnvVar,
  type ProjectEnvVarRow,
} from '#db'
import { ServerError } from '@yaac/shared/errors'
import { assertProjectExists } from './detail'
import type { ProjectEnvVar, SecretProxyRule } from '@yaac/shared/types'

/**
 * A project's environment: variables its workspaces launch with, and secrets
 * the egress proxy injects. Validates what the store doesn't: the project
 * exists, names are shell-legal, and a secret's rule is one the proxy can
 * act on (a bad rule would otherwise be dropped silently inside the proxy).
 *
 * Secret values never leave here, except through {@link resolveProjectEnv}
 * for workspace create.
 */

/** A shell-legal variable name. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Validate one secret's injection rule against what the proxy can act on. */
export function parseSecretProxyRule(name: string, raw: unknown): SecretProxyRule {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ServerError(
      'VALIDATION',
      `${name}: a secret needs a rule with hosts, and either header or bodyParam`,
    )
  }
  const rule = raw as Record<string, unknown>
  if (!Array.isArray(rule.hosts) || rule.hosts.length === 0
    || !rule.hosts.every((v) => typeof v === 'string' && v.length > 0)) {
    throw new ServerError('VALIDATION', `${name}: hosts must be a non-empty list of hostnames`)
  }
  for (const field of ['path', 'header', 'prefix', 'bodyParam'] as const) {
    if (rule[field] !== undefined && typeof rule[field] !== 'string') {
      throw new ServerError('VALIDATION', `${name}: ${field} must be a string`)
    }
  }
  // A blank header or body param is dangerous: the rule builder tests
  // `if (rule.bodyParam)`, so blank falls through to the default
  // `authorization: Bearer <secret>`, sending the credential in a header
  // nobody configured. Absent means "use the default"; blank is an error.
  for (const field of ['header', 'bodyParam'] as const) {
    if (rule[field] !== undefined && (rule[field] as string).trim() === '') {
      throw new ServerError(
        'VALIDATION',
        `${name}: ${field} cannot be empty — name the ${field === 'header' ? 'header' : 'body parameter'} `
        + 'the secret is injected into, or leave it unset for the default authorization header',
      )
    }
  }
  if (rule.header && rule.bodyParam) {
    throw new ServerError('VALIDATION', `${name}: a rule cannot have both header and bodyParam`)
  }
  return {
    hosts: rule.hosts as string[],
    ...(rule.path !== undefined ? { path: rule.path as string } : {}),
    ...(rule.header !== undefined ? { header: rule.header as string } : {}),
    ...(rule.prefix !== undefined ? { prefix: rule.prefix as string } : {}),
    ...(rule.bodyParam !== undefined ? { bodyParam: rule.bodyParam as string } : {}),
  }
}

/** Project a row for a client: plain values pass, secret values never do. */
function toWire(row: ProjectEnvVarRow): ProjectEnvVar {
  return {
    id: row.id,
    name: row.name,
    secret: row.secret,
    hasValue: row.secret ? row.value !== undefined && row.value !== '' : true,
    ...(row.secret ? {} : { value: row.value ?? '' }),
    ...(row.rule !== undefined ? { rule: row.rule } : {}),
  }
}

/** Every variable a project has, for the settings UI. */
export async function listProjectEnv(slug: string): Promise<ProjectEnvVar[]> {
  await assertProjectExists(slug)
  return (await listProjectEnvVars(slug)).map(toWire)
}

/**
 * Create or replace one variable. A secret may omit its value only if one is
 * already stored (to edit just the rule); otherwise the row would look saved
 * but be skipped at create.
 */
export async function setProjectEnvVar(slug: string, input: {
  name: string
  value?: string
  secret?: boolean
  rule?: unknown
}): Promise<ProjectEnvVar> {
  await assertProjectExists(slug)
  const name = input.name.trim()
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new ServerError(
      'VALIDATION',
      `"${name}" is not a valid environment variable name (letters, digits and `
      + 'underscores, not starting with a digit)',
    )
  }
  if (input.value !== undefined && typeof input.value !== 'string') {
    throw new ServerError('VALIDATION', `${name}: value must be a string`)
  }
  const secret = input.secret === true
  if (!secret) {
    if (input.value === undefined) {
      throw new ServerError('VALIDATION', `${name}: a value is required`)
    }
    const row = await upsertProjectEnvVar(slug, { name, value: input.value, secret: false })
    return toWire(row)
  }

  const rule = parseSecretProxyRule(name, input.rule)
  if (input.value === undefined || input.value === '') {
    // A stored `''` counts as no value, since `resolveProjectEnv` drops it; a
    // rule-only edit on it must not report success.
    const existing = (await listProjectEnvVars(slug))
      .find((r) => r.name === name && r.secret && r.value !== undefined && r.value !== '')
    if (!existing) {
      throw new ServerError('VALIDATION', `${name}: a value is required for a new secret`)
    }
    return toWire(await upsertProjectEnvVar(slug, { name, secret: true, rule }))
  }
  return toWire(await upsertProjectEnvVar(slug, { name, value: input.value, secret: true, rule }))
}

/** Remove one variable by id. */
export async function removeProjectEnvVar(slug: string, id: string): Promise<void> {
  await assertProjectExists(slug)
  if (!await deleteProjectEnvVar(slug, id)) {
    throw new ServerError('NOT_FOUND', `no environment variable ${id} in project ${slug}`)
  }
}

/** What a workspace launch needs: plain variables, and secrets that have a
 *  value. */
export interface ResolvedProjectEnv {
  plain: Record<string, string>
  secrets: Record<string, { value: string; rule: SecretProxyRule }>
}

/**
 * Resolve a project's environment for a workspace create. A secret with no
 * usable value (never set, or encrypted under a lost key) or no rule is
 * dropped rather than injected blank, which upstreams would report as a bad
 * credential instead of a missing one.
 */
export async function resolveProjectEnv(slug: string): Promise<ResolvedProjectEnv> {
  const rows = await listProjectEnvVars(slug)
  const plain: Record<string, string> = {}
  const secrets: Record<string, { value: string; rule: SecretProxyRule }> = {}
  for (const row of rows) {
    if (!row.secret) {
      plain[row.name] = row.value ?? ''
      continue
    }
    if (row.value === undefined || row.value === '' || row.rule === undefined) continue
    secrets[row.name] = { value: row.value, rule: row.rule }
  }
  return { plain, secrets }
}
