import { useState, type FormEvent, type JSX, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '#lib/api'
import { parseDuration } from '@yaac/shared/schedule'
import { PERMISSION_MODES, type PermissionMode, type TokenBindingList, type TokenBindingSummary } from '@yaac/shared/types'
import { YButton, YConfirm, YInput, YRowFrame, YSection, YSelect, YSettingGroup, YSettingRow } from '#ui'

/**
 * Token bindings (docs/remote-hosting.md "Token access"): what lets a
 * program on this server's token listener act as a user, as a delegate. A
 * user makes and deletes their own; an admin sees and deletes anyone's
 * (`userId`) under Settings → Users.
 */

const tokensKey = (userId?: string): unknown[] => ['tokens', userId ?? 'me']

function useTokens(userId?: string): { data: TokenBindingList | undefined; refresh: () => Promise<void> } {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: tokensKey(userId),
    queryFn: () => api.token.$get({ query: userId !== undefined ? { user: userId } : {} }),
  })
  return { data, refresh: () => queryClient.invalidateQueries({ queryKey: tokensKey(userId) }) }
}

/** Help text for issuers whose subjects are worth explaining. */
const ISSUER_HINTS: Record<string, ReactNode> = {
  'https://accounts.google.com': (
    <>The subject is the service account&apos;s unique ID: <code>gcloud iam service-accounts describe &lt;email&gt; --format=&apos;value(uniqueId)&apos;</code>.</>
  ),
  'https://token.actions.githubusercontent.com': (
    <>
      The subject is <code>repo:&lt;owner&gt;/&lt;repo&gt;:environment:&lt;name&gt;</code> or{' '}
      <code>repo:&lt;owner&gt;/&lt;repo&gt;:ref:refs/heads/&lt;branch&gt;</code>. Whoever can run a workflow there can act as
      you, an agent that can push there included, so bind an environment with required reviewers rather than a branch.
    </>
  ),
}
const GITHUB = 'https://token.actions.githubusercontent.com'

/** The caller's own bindings, with the forms that make new ones. */
export function Tokens(): JSX.Element {
  const { data, refresh } = useTokens()
  return (
    <YSection
      title="Tokens"
      description={(
        <>
          Let a program off the tailnet reach this server&apos;s token listener as you, with an agent&apos;s reach across all your
          projects up to the permission mode you pick.{' '}
          {data?.fingerprint === null
            ? 'This server has no token listener; start it with --token-listen <addr>:<port>.'
            : data !== undefined && <>Callers pin the listener&apos;s key: <code className="break-all">{data.fingerprint}</code></>}
        </>
      )}
    >
      <YSettingGroup className="text-md">
        <TokenRows bindings={data?.bindings} onChanged={refresh} />
        <YSettingRow stacked label="New token" hint="A personal access token, shown once.">
          <NewToken onDone={refresh} />
        </YSettingRow>
        <YSettingRow stacked label="New identity" hint="Accept tokens an OIDC issuer mints for one subject, such as a GCP service account or a GitHub Actions job.">
          <NewIdentity onDone={refresh} />
        </YSettingRow>
      </YSettingGroup>
    </YSection>
  )
}

/** Another user's bindings, for an admin, who may delete them. */
export function UserTokens({ userId }: { userId: string }): JSX.Element {
  const { data, refresh } = useTokens(userId)
  return (
    <YSettingGroup className="text-md">
      <TokenRows bindings={data?.bindings} onChanged={refresh} />
    </YSettingGroup>
  )
}

function TokenRows({ bindings, onChanged }: { bindings: TokenBindingSummary[] | undefined; onChanged: () => Promise<void> }): JSX.Element {
  const [deleting, setDeleting] = useState<TokenBindingSummary | null>(null)
  const remove = useMutation({
    mutationFn: async (id: string) => { await api.token[':id'].$delete({ param: { id } }) },
    onSuccess: () => { setDeleting(null); void onChanged() },
  })
  return (
    <>
      {bindings?.length === 0 && <p className="px-4 py-3 text-subtle">No tokens.</p>}
      {bindings?.map((b) => (
        <div key={b.id} className="flex flex-col gap-1 px-4 py-2">
          <YRowFrame
            label={b.label}
            actionsShown
            actions={<YButton variant="danger" size="sm" onClick={() => setDeleting(b)}>Delete</YButton>}
            className="min-h-7"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium text-text">{b.label}</span>
              <span className="shrink-0 font-mono text-subtle">{b.kind === 'pat' ? 'token' : 'identity'}</span>
              <span className="shrink-0 text-subtle">{b.ceiling}</span>
            </span>
            <span className="shrink-0 text-sm text-subtle">
              {b.lastUsedAt === null ? 'never used' : `used ${day(b.lastUsedAt)}`}
              {b.expiresAt !== null && ` · expires ${day(b.expiresAt)}`}
            </span>
          </YRowFrame>
          {b.kind === 'oidc' && (
            <div className="flex flex-col gap-0.5 text-sm text-subtle">
              <span className="break-all">{b.issuer} · subject <code>{b.subject}</code> · audience <code>{b.audience}</code></span>
              {Object.entries(b.claims ?? {}).map(([name, value]) => <span key={name}>{name} = <code>{value}</code></span>)}
              {b.refusedSubject !== undefined && (
                <span className="text-danger">
                  Refused a token for subject <code>{b.refusedSubject}</code>{b.refusedAt !== undefined && ` on ${day(b.refusedAt)}`}.
                </span>
              )}
            </div>
          )}
        </div>
      ))}
      <YConfirm
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) setDeleting(null) }}
        title={`Delete ${deleting?.label ?? ''}?`}
        description="Its next request is refused, and nothing can bring it back."
        busy={remove.isPending}
        error={remove.error?.message}
        onConfirm={() => { if (deleting) remove.mutate(deleting.id) }}
      />
    </>
  )
}

/** The fields every binding takes: label, expiry and permission mode. */
function useCommon(): {
  fields: JSX.Element
  value: () => { label: string; expiresInMinutes?: number; permissionMode?: PermissionMode }
  reset: () => void
} {
  const [label, setLabel] = useState('')
  const [expires, setExpires] = useState('')
  const [mode, setMode] = useState('')
  const fields = (
    <>
      <YInput aria-label="Label" placeholder="label" value={label} onChange={(e) => setLabel(e.target.value)} className="w-40" />
      <YInput aria-label="Expires after" placeholder="expires after (e.g. 30d)" value={expires} onChange={(e) => setExpires(e.target.value)} className="w-48" />
      <YSelect aria-label="Permission mode" value={mode} onChange={(e) => setMode(e.target.value)} className="w-fit">
        <option value="">Default mode</option>
        {PERMISSION_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
      </YSelect>
    </>
  )
  return {
    fields,
    reset: () => {
      setLabel('')
      setExpires('')
      setMode('')
    },
    value: () => {
      const minutes = expires.trim() === '' ? undefined : parseDuration(expires)
      if (expires.trim() !== '' && minutes === undefined) throw new Error('expires after takes a duration such as 30d or 12h')
      return {
        label: label.trim(),
        ...(minutes !== undefined ? { expiresInMinutes: minutes } : {}),
        ...(mode !== '' ? { permissionMode: mode as PermissionMode } : {}),
      }
    },
  }
}

function NewToken({ onDone }: { onDone: () => Promise<void> }): JSX.Element {
  const common = useCommon()
  const [token, setToken] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: async () => (await api.token.$post({ json: { kind: 'pat', ...common.value() } })).token ?? null,
    onSuccess: (t) => {
      setToken(t)
      common.reset()
      void onDone()
    },
  })
  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    create.mutate()
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {common.fields}
        <YButton type="submit" size="sm" disabled={create.isPending}>Create</YButton>
      </div>
      {create.error && <p className="text-sm text-danger">{create.error.message}</p>}
      {token !== null && (
        <p className="text-sm text-muted">
          Copy it now; it is not shown again: <code className="select-all break-all text-text">{token}</code>
        </p>
      )}
    </form>
  )
}

function NewIdentity({ onDone }: { onDone: () => Promise<void> }): JSX.Element {
  const common = useCommon()
  const [issuer, setIssuer] = useState('')
  const [subject, setSubject] = useState('')
  const [repoId, setRepoId] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [audience, setAudience] = useState<string | null>(null)
  const github = issuer.trim() === GITHUB
  const create = useMutation({
    mutationFn: async () => (await api.token.$post({
      json: {
        kind: 'oidc',
        ...common.value(),
        issuer: issuer.trim(),
        subject: subject.trim(),
        claims: github ? { repository_id: repoId.trim(), repository_owner_id: ownerId.trim() } : {},
      },
    })).binding.audience ?? null,
    onSuccess: (a) => {
      setAudience(a)
      common.reset()
      setSubject('')
      setRepoId('')
      setOwnerId('')
      void onDone()
    },
  })
  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    create.mutate()
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <YInput aria-label="Issuer" placeholder="issuer URL" value={issuer} onChange={(e) => setIssuer(e.target.value)} className="w-80" />
        <YInput aria-label="Subject" placeholder="subject" value={subject} onChange={(e) => setSubject(e.target.value)} className="w-64" />
        {github && (
          <>
            <YInput aria-label="Repository id" placeholder="repository_id" value={repoId} onChange={(e) => setRepoId(e.target.value)} className="w-36" />
            <YInput aria-label="Repository owner id" placeholder="repository_owner_id" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className="w-44" />
          </>
        )}
      </div>
      {ISSUER_HINTS[issuer.trim()] !== undefined && <p className="text-sm text-muted">{ISSUER_HINTS[issuer.trim()]}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {common.fields}
        <YButton type="submit" size="sm" disabled={create.isPending}>Bind</YButton>
      </div>
      {create.error && <p className="text-sm text-danger">{create.error.message}</p>}
      {audience !== null && (
        <p className="text-sm text-muted">
          Mint tokens for the audience <code className="select-all break-all text-text">{audience}</code> and send each as{' '}
          <code>Authorization: Bearer &lt;token&gt;</code>.
        </p>
      )}
    </form>
  )
}

function day(ms: number): string {
  return new Date(ms).toLocaleDateString()
}
