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
 * A project's environment: the variables its worktrees launch with, and the
 * secrets the egress proxy injects on their behalf.
 *
 * The mediator over the env rows. It owns three things the store does not:
 * that the project exists, that a name is a name a shell will accept, and
 * that a secret's injection rule says something the proxy can act on — a
 * rule with no hosts, or with both a header and a body param, is a rule that
 * would be silently dropped much later, inside the proxy, with nothing on
 * screen to say why the credential never arrived.
 *
 * What leaves here never carries a secret's value. The one exception is
 * {@link resolveProjectEnv}, which is the create path asking for what to put
 * in a workspace — the question the values exist to answer.
 */

/** A shell-legal variable name: what `NAME=value` in an env list can hold. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Validate one secret's injection rule, in the vocabulary the proxy speaks.
 *
 * The rule lives in a row rather than a file, but the proxy is the reader
 * either way, so validity is defined by what it can act on.
 */
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
  // An EMPTY header or body param is the dangerous case, not a harmless one:
  // the rule builder asks `if (rule.bodyParam)`, so a present-but-blank one
  // falls through to the default `authorization: Bearer <secret>` — the
  // credential leaving in a header nobody configured. Absent means "use the
  // default"; blank means the user picked a field and did not name it.
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
 * Create or replace one variable.
 *
 * A secret may be saved with no value only when one is already stored — that
 * is how its rule is edited without the secret travelling again. Saving a
 * secret that has never had one would write a row the create path skips,
 * which reads as "saved" and behaves as "absent".
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
    // `''` counts as no value, not as an empty one: the legacy importer
    // stores an unresolvable secret that way, and a rule-only edit on one
    // must not report success while `resolveProjectEnv` goes on dropping it.
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

/** What a worktree launch needs: the plain variables, and the secrets that
 *  actually have a value behind them. */
export interface ResolvedProjectEnv {
  plain: Record<string, string>
  secrets: Record<string, { value: string; rule: SecretProxyRule }>
}

/**
 * Resolve a project's environment for a worktree create.
 *
 * A secret with no usable value — never supplied, or sealed under a key this
 * install no longer has — is dropped rather than passed through empty: the
 * proxy would inject a blank header, and an upstream rejects that as a bad
 * credential rather than a missing one, which sends whoever debugs it after
 * the wrong thing. Same for a secret with no rule, which nothing would swap.
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
