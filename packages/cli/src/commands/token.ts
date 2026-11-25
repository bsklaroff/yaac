/**
 * `yaac token …`: the caller's token bindings (docs/remote-hosting.md
 * "Token access"), which let a program reach the token listener as them.
 * These commands manage bindings over the main origin, as a person; none
 * of them calls the token listener. With `--user`, `list` and `delete` act
 * on another user's, for an admin.
 */
import { parseDuration } from '@yaac/shared/schedule'
import { PERMISSION_MODES, type PermissionMode } from '@yaac/shared/types'
import { api, scopedUserId } from '#commands/api'
import { printTable } from '#commands/table'

export interface TokenCreateOptions {
  expires?: string
  permissionMode?: string
}

export interface TokenBindOptions extends TokenCreateOptions {
  issuer: string
  subject: string
  claim?: string[]
}

/** `yaac token list`. */
export async function tokenList(): Promise<void> {
  const user = await scopedUserId()
  const { fingerprint, bindings } = await api.token.$get({ query: user !== undefined ? { user } : {} })
  if (bindings.length === 0) console.log('no tokens')
  else {
    printTable(
      [
        { header: 'LABEL' }, { header: 'KIND' }, { header: 'MODE' }, { header: 'LAST USED' }, { header: 'EXPIRES' },
        { header: 'AUDIENCE', optional: true }, { header: 'SUBJECT', optional: true }, { header: 'LAST REFUSED SUBJECT', optional: true },
      ],
      bindings.map((b) => [
        b.label, b.kind, b.ceiling, when(b.lastUsedAt) ?? 'never', when(b.expiresAt) ?? 'never',
        b.audience ?? '', b.subject ?? '', b.refusedSubject ?? '',
      ]),
    )
  }
  console.error(fingerprint === null
    ? '[yaac] this server has no token listener; start it with --token-listen <addr>:<port>'
    : `[yaac] the token listener's key fingerprint: ${fingerprint}`)
}

/** `yaac token create <label>`: prints the token, which is shown only now. */
export async function tokenCreate(label: string, opts: TokenCreateOptions): Promise<void> {
  const { token, binding } = await api.token.$post({ json: { kind: 'pat', label, ...common(opts) } })
  console.log(token)
  console.error(`[yaac] token ${binding.label} acts as you, up to permission mode ${binding.ceiling}; it is not shown again`)
}

/** `yaac token bind <label>`: prints the audience its tokens must name. */
export async function tokenBind(label: string, opts: TokenBindOptions): Promise<void> {
  const claims: Record<string, string> = {}
  for (const pair of opts.claim ?? []) {
    const eq = pair.indexOf('=')
    if (eq <= 0) throw new Error(`--claim takes <name>=<value> (got "${pair}")`)
    claims[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  const { binding } = await api.token.$post({
    json: { kind: 'oidc', label, issuer: opts.issuer, subject: opts.subject, claims, ...common(opts) },
  })
  console.log(binding.audience)
  console.error(`[yaac] a token from ${opts.issuer} for subject ${opts.subject} with this audience acts as you, up to permission mode ${binding.ceiling}`)
}

/** `yaac token delete <label>`. */
export async function tokenDelete(label: string): Promise<void> {
  const user = await scopedUserId()
  const { bindings } = await api.token.$get({ query: user !== undefined ? { user } : {} })
  const binding = bindings.find((b) => b.label === label)
  if (binding === undefined) throw new Error(`no token named "${label}"; see \`yaac token list\``)
  await api.token[':id'].$delete({ param: { id: binding.id } })
  console.log(`deleted token ${label}`)
}

function common(opts: TokenCreateOptions): { expiresInMinutes?: number; permissionMode?: PermissionMode } {
  const out: { expiresInMinutes?: number; permissionMode?: PermissionMode } = {}
  if (opts.expires !== undefined) {
    const minutes = parseDuration(opts.expires)
    if (minutes === undefined) throw new Error(`--expires takes a duration such as 30d, 12h or 1d12h (got "${opts.expires}")`)
    out.expiresInMinutes = minutes
  }
  if (opts.permissionMode !== undefined) {
    if (!(PERMISSION_MODES as readonly string[]).includes(opts.permissionMode)) {
      throw new Error(`--permission-mode takes one of ${PERMISSION_MODES.join(', ')} (got "${opts.permissionMode}")`)
    }
    out.permissionMode = opts.permissionMode as PermissionMode
  }
  return out
}

function when(ms: number | null): string | undefined {
  return ms === null ? undefined : new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}
