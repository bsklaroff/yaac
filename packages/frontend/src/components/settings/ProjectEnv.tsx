import { useState, type FormEvent, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DeleteIcon } from '#lib/icons'
import { api } from '#lib/api'
import { SectionLabel } from '#components/settings/Field'
import type { ProjectEnvVar, SecretProxyRule } from '@yaac/shared/types'

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
      <span className="mb-1 block text-[10px] text-text-faint">{label}</span>
      {children}
    </label>
  )
}

/**
 * A project's environment variables and proxied secrets. They are stored on
 * the server (secrets encrypted) rather than in `yaac-config.json`, so a
 * client on another machine can set them. A secret's value is write-only:
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

  const inputClass = 'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono '
    + 'text-xs text-text outline-none focus:border-border-strong'

  const edit = (v: ProjectEnvVar): void => { setEditing(v.id); setDraft(draftFrom(v)) }
  const row = (v: ProjectEnvVar, detail: JSX.Element): JSX.Element => (
    <div
      key={v.id}
      className={clsx('flex items-center gap-2 rounded-md bg-bg px-2.5 py-1.5 font-mono text-xs',
        editing === v.id && 'ring-1 ring-accent-soft')}
    >
      <button
        onClick={() => edit(v)}
        disabled={readOnly || busy}
        title={readOnly ? undefined : `Edit ${v.name}`}
        className={clsx('flex min-w-0 flex-1 items-center gap-3 text-left',
          !readOnly && 'transition hover:opacity-80')}
      >
        <span className="max-w-[50%] shrink-0 truncate text-text">{v.name}</span>
        {detail}
      </button>
      {!readOnly && <button
        onClick={() => { save.reset(); remove.mutate(v) }}
        disabled={busy}
        aria-label={`Delete ${v.name}`}
        className="shrink-0 text-text-faint transition hover:text-text disabled:opacity-50"
      >
        <DeleteIcon size={12} />
      </button>}
    </div>
  )
  const plain = vars?.filter((v) => !v.secret) ?? []
  const secrets = vars?.filter((v) => v.secret) ?? []

  return (
    <div>
      <SectionLabel>Environment</SectionLabel>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Variables every workspace of this project starts with. Applies to workspaces
        created after saving.
      </p>

      {plain.length > 0 && <div className="mt-3 space-y-1">
        {plain.map((v) => row(v, <span className="min-w-0 flex-1 truncate text-text-faint">{v.value}</span>))}
      </div>}

      {secrets.length > 0 && <>
        <div className="mt-4"><SectionLabel>Secrets</SectionLabel></div>
        <div className="mt-2 space-y-1">
          {secrets.map((v) => row(v, <>
            <span className={clsx('shrink-0', v.hasValue ? 'text-text-faint' : 'font-sans text-[11px] text-error')}>
              {v.hasValue ? '••••••••' : 'no value stored'}
            </span>
            <span title={ruleSummary(v.rule)} className="min-w-0 flex-1 truncate text-right text-accent">
              {v.rule?.hosts.join(', ')}
            </span>
          </>))}
        </div>
      </>}

      {readOnly && vars?.length === 0 && <p className="mt-3 text-[11px] text-text-faint">None set.</p>}

      {!readOnly && <form onSubmit={submit} className="mt-3 space-y-2">
        <div className="flex gap-2">
          <div role="radiogroup" aria-label="Kind" className="flex shrink-0 rounded-md border border-border bg-bg p-0.5">
            {([['Variable', false], ['Secret', true]] as const).map(([label, secret]) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={draft.secret === secret}
                onClick={() => setDraft({ ...draft, secret })}
                className={clsx('rounded px-2 text-[11px] transition',
                  draft.secret === secret ? 'bg-surface-3 text-text' : 'text-text-faint hover:text-text')}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="NAME"
            className={clsx(inputClass, 'min-w-0 flex-1')}
          />
          <input
            value={draft.value}
            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
            type={draft.secret ? 'password' : 'text'}
            placeholder={draft.secret && editing !== null ? 'unchanged' : 'value'}
            className={clsx(inputClass, 'min-w-0 flex-1')}
          />
        </div>

        {draft.secret && (
          <p className="text-[11px] leading-relaxed text-text-faint">
            Stored encrypted and never shown again.{' '}
            {mediatedEgress
              ? 'The workspace sees only a placeholder; the proxy swaps in the value on requests matching:'
              : 'The workspace gets the real value in its environment.'}
          </p>
        )}

        {draft.secret && (
          <div className="space-y-2 rounded-md border border-border p-2">
            <Caption label="hosts">
              <input
                value={draft.hosts}
                onChange={(e) => setDraft({ ...draft, hosts: e.target.value })}
                placeholder="api.example.com, *.example.com"
                className={inputClass}
              />
            </Caption>
            <Caption label="inject into">
              <div className="flex gap-2">
                <select
                  value={draft.injectInto}
                  onChange={(e) => {
                    const injectInto = e.target.value === 'bodyParam' ? 'bodyParam' : 'header'
                    // Swap in the new kind's default unless the user named a field.
                    const field = draft.field === DEFAULT_HEADER || draft.field === ''
                      ? (injectInto === 'header' ? DEFAULT_HEADER : '')
                      : draft.field
                    setDraft({ ...draft, injectInto, field })
                  }}
                  className="rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-text
                    outline-none focus:border-border-strong"
                >
                  <option value="header">Header</option>
                  <option value="bodyParam">Body parameter</option>
                </select>
                <input
                  value={draft.field}
                  onChange={(e) => setDraft({ ...draft, field: e.target.value })}
                  placeholder={draft.injectInto === 'header' ? DEFAULT_HEADER : 'client_secret'}
                  className={clsx(inputClass, 'flex-1')}
                />
              </div>
            </Caption>
            <div className="flex gap-2">
              <Caption label="path" className="flex-1">
                <input
                  value={draft.path}
                  onChange={(e) => setDraft({ ...draft, path: e.target.value })}
                  className={inputClass}
                />
              </Caption>
              {draft.injectInto === 'header' && (
                <Caption label="prefix" className="flex-1">
                  <input
                    value={draft.prefix}
                    onChange={(e) => setDraft({ ...draft, prefix: e.target.value })}
                    placeholder="none"
                    className={inputClass}
                  />
                </Caption>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={busy || draft.name.trim() === ''}
            className="rounded-md bg-surface-3 px-3 py-1 text-xs font-medium text-text transition
              hover:bg-border-strong disabled:opacity-50"
          >
            {editing !== null ? 'Save' : 'Add'}
          </button>
          {editing !== null && (
            <button
              type="button"
              onClick={() => { setEditing(null); setDraft(EMPTY) }}
              className="text-[11px] text-text-faint transition hover:text-text"
            >
              Cancel
            </button>
          )}
        </div>
      </form>}

      {error && <p className="mt-2 text-xs text-red-400">{error.message}</p>}
    </div>
  )
}
