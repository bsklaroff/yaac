import { useState, type FormEvent, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DeleteIcon } from '#lib/icons'
import { api } from '#lib/api'
import type { ProjectEnvVar, SecretProxyRule } from '@yaac/shared/types'
import { YButton, YInput, YSectionLabel, YSegmented, YSelect, YSettingRow } from '#ui'

/** One-line summary of where a secret is injected, for the row. */
function ruleSummary(rule: SecretProxyRule | undefined): string {
  if (!rule) return ''
  const where = rule.bodyParam
    ? `body ${rule.bodyParam}`
    : `header ${rule.header ?? 'authorization'}`
  const path = rule.path && rule.path !== '/*' ? ` ${rule.path}` : ''
  return `${rule.hosts.join(', ')}${path} · ${where}`
}

interface Draft {
  name: string
  value: string
  secret: boolean
  hosts: string
  path: string
  injectInto: 'header' | 'bodyParam'
  field: string
  prefix: string
}

const KINDS = [{ value: 'variable', label: 'Variable' }, { value: 'secret', label: 'Secret' }] as const

/** A header field's default, as the proxy applies it to a rule naming none. */
const DEFAULT_HEADER = 'authorization'

/** Starts on the proxy's defaults, so the user sees what a rule does. */
const EMPTY: Draft = {
  name: '', value: '', secret: false,
  hosts: '', path: '/*', injectInto: 'header', field: DEFAULT_HEADER, prefix: 'Bearer ',
}

function draftFrom(v: ProjectEnvVar): Draft {
  const rule = v.rule
  return {
    name: v.name,
    value: v.value ?? '',
    secret: v.secret,
    hosts: rule?.hosts.join(', ') ?? '',
    path: rule?.path ?? EMPTY.path,
    injectInto: rule?.bodyParam ? 'bodyParam' : 'header',
    field: rule?.bodyParam ?? rule?.header ?? DEFAULT_HEADER,
    // The proxy prefixes "Bearer " only when the rule names no header.
    prefix: rule?.prefix ?? (rule?.header ? '' : EMPTY.prefix),
  }
}

function ruleFromDraft(draft: Draft): SecretProxyRule {
  const hosts = draft.hosts.split(/[\s,]+/).map((h) => h.trim()).filter((h) => h.length > 0)
  const field = draft.field.trim()
  return {
    hosts,
    path: draft.path.trim() || EMPTY.path,
    // The prefix is sent even when blank, so clearing it means no prefix.
    ...(draft.injectInto === 'bodyParam'
      ? { bodyParam: field }
      : { ...(field ? { header: field } : {}), prefix: draft.prefix }),
  }
}

/** A small caption over a rule field. */
function Caption({ label, className, children }: { label: string; className?: string; children: ReactNode }): JSX.Element {
  return (
    <label className={clsx('block min-w-0', className)}>
      <span className="mb-1 block text-xs text-subtle">{label}</span>
      {children}
    </label>
  )
}

/**
 * A project's environment variables and proxied secrets, stored on the
 * server (secrets encrypted). A secret's value is write-only:
 * leaving it blank in an edit keeps the stored value. `readOnly` (a
 * teammate's project) only lists them.
 */
export function ProjectEnv({ projectId, mediatedEgress, readOnly = false }: {
  projectId: string
  mediatedEgress: boolean
  readOnly?: boolean
}): JSX.Element {
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [editing, setEditing] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const queryKey = ['project-env', projectId]
  const { data: vars, error: loadError } = useQuery({
    queryKey,
    queryFn: async () => (await api.project[':projectId'].env.$get({ param: { projectId } })).vars,
    staleTime: 0,
  })

  const save = useMutation({
    mutationFn: () => api.project[':projectId'].env.$put({
      param: { projectId },
      json: {
        name: draft.name.trim(),
        // Omit a blank secret value so the server keeps the stored one.
        ...(draft.secret && draft.value === '' ? {} : { value: draft.value }),
        secret: draft.secret,
        ...(draft.secret ? { rule: ruleFromDraft(draft) } : {}),
      },
    }),
    onSuccess: () => {
      setDraft(EMPTY)
      setEditing(null)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })
  const remove = useMutation({
    mutationFn: (v: ProjectEnvVar) => api.project[':projectId'].env[':id'].$delete({ param: { projectId, id: v.id } }),
    onSuccess: (_, v) => {
      if (editing === v.id) {
        setEditing(null)
        setDraft(EMPTY)
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })
  const busy = save.isPending || remove.isPending
  const error = save.error ?? remove.error ?? loadError

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    remove.reset()
    save.mutate()
  }

  const edit = (v: ProjectEnvVar): void => { setEditing(v.id); setDraft(draftFrom(v)) }
  const row = (v: ProjectEnvVar, detail: JSX.Element): JSX.Element => (
    <div
      key={v.id}
      className={clsx('flex min-h-8 items-center gap-2 font-mono text-md', editing === v.id ? 'bg-selected' : !readOnly && 'hover:bg-hover')}
    >
      <YButton
        variant="bare"
        onClick={() => edit(v)}
        disabled={readOnly || busy}
        title={readOnly ? undefined : `Edit ${v.name}`}
        className="flex min-h-8 min-w-0 flex-1 items-center gap-3 self-stretch text-left disabled:opacity-100"
      >
        <span className="max-w-[50%] shrink-0 truncate text-text">{v.name}</span>
        {detail}
      </YButton>
      {!readOnly && <YButton
        variant="ghost"
        size="sm"
        icon={DeleteIcon}
        onClick={() => { save.reset(); remove.mutate(v) }}
        disabled={busy}
        aria-label={`Delete ${v.name}`}
      />}
    </div>
  )
  const plain = vars?.filter((v) => !v.secret) ?? []
  const secrets = vars?.filter((v) => v.secret) ?? []

  return (
    <YSettingRow
      stacked
      label="Environment"
      hint="Set in every new workspace."
    >
      {plain.length > 0 && <div className="divide-y divide-line">
        {plain.map((v) => row(v, <span className="min-w-0 flex-1 truncate text-subtle">{v.value}</span>))}
      </div>}

      {secrets.length > 0 && <>
        <YSectionLabel className={clsx('pb-1', plain.length > 0 && 'mt-3')}>Secrets</YSectionLabel>
        <div className="divide-y divide-line">
          {secrets.map((v) => row(v, <>
            <span className={clsx('shrink-0', v.hasValue ? 'text-subtle' : 'font-sans text-sm text-danger')}>
              {v.hasValue ? '••••••••' : 'no value stored'}
            </span>
            <span title={ruleSummary(v.rule)} className="min-w-0 flex-1 truncate text-right text-accent">
              {v.rule?.hosts.join(', ')}
            </span>
          </>))}
        </div>
      </>}

      {readOnly && vars?.length === 0 && <p className="text-md text-subtle">None set.</p>}

      {!readOnly && <form onSubmit={submit} className={clsx('space-y-2', vars !== undefined && vars.length > 0 && 'mt-2')}>
        <div className="flex gap-2">
          <YSegmented
            ariaLabel="Kind"
            options={KINDS}
            value={draft.secret ? 'secret' : 'variable'}
            onChange={(kind) => setDraft({ ...draft, secret: kind === 'secret' })}
          />
          <YInput
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="NAME"
            className="flex-1 font-mono"
          />
          <YInput
            value={draft.value}
            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
            type={draft.secret ? 'password' : 'text'}
            placeholder={draft.secret && editing !== null ? 'unchanged' : 'value'}
            className="flex-1 font-mono"
          />
        </div>

        {draft.secret && (
          <p className="text-sm leading-relaxed text-subtle">
            Stored encrypted and never shown again.{' '}
            {mediatedEgress
              ? 'The workspace sees only a placeholder; the proxy swaps in the value on requests matching:'
              : 'The workspace gets the real value in its environment.'}
          </p>
        )}

        {draft.secret && (
          <div className="space-y-2 rounded-sm p-2 shadow-inset">
            <Caption label="hosts">
              <YInput
                value={draft.hosts}
                onChange={(e) => setDraft({ ...draft, hosts: e.target.value })}
                placeholder="api.example.com, *.example.com"
                className="w-full font-mono"
              />
            </Caption>
            <Caption label="inject into">
              <div className="flex gap-2">
                <YSelect
                  value={draft.injectInto}
                  onChange={(e) => {
                    const injectInto = e.target.value === 'bodyParam' ? 'bodyParam' : 'header'
                    // Swap in the new kind's default unless the user named a field.
                    const field = draft.field === DEFAULT_HEADER || draft.field === ''
                      ? (injectInto === 'header' ? DEFAULT_HEADER : '')
                      : draft.field
                    setDraft({ ...draft, injectInto, field })
                  }}
                >
                  <option value="header">Header</option>
                  <option value="bodyParam">Body parameter</option>
                </YSelect>
                <YInput
                  value={draft.field}
                  onChange={(e) => setDraft({ ...draft, field: e.target.value })}
                  placeholder={draft.injectInto === 'header' ? DEFAULT_HEADER : 'client_secret'}
                  className="flex-1 font-mono"
                />
              </div>
            </Caption>
            <div className="flex gap-2">
              <Caption label="path" className="flex-1">
                <YInput
                  value={draft.path}
                  onChange={(e) => setDraft({ ...draft, path: e.target.value })}
                  className="w-full font-mono"
                />
              </Caption>
              {draft.injectInto === 'header' && (
                <Caption label="prefix" className="flex-1">
                  <YInput
                    value={draft.prefix}
                    onChange={(e) => setDraft({ ...draft, prefix: e.target.value })}
                    placeholder="none"
                    className="w-full font-mono"
                  />
                </Caption>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <YButton type="submit" disabled={busy || draft.name.trim() === ''}>
            {editing !== null ? 'Save' : 'Add'}
          </YButton>
          {editing !== null && (
            <YButton variant="ghost" size="sm" onClick={() => { setEditing(null); setDraft(EMPTY) }}>
              Cancel
            </YButton>
          )}
        </div>
      </form>}

      {error && <p className="mt-2 text-md text-danger">{error.message}</p>}
    </YSettingRow>
  )
}
