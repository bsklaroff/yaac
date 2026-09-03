import { useCallback, useEffect, useState, type FormEvent, type JSX } from 'react'
import clsx from 'clsx'
import { DeleteIcon } from '#lib/icons'
import { deleteProjectEnvVar, getProjectEnv, setProjectEnvVar } from '#lib/projectApi'
import type { ProjectEnvVar, SecretProxyRule } from '@yaac/shared/types'

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

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

const EMPTY: Draft = {
  name: '', value: '', secret: false,
  hosts: '', path: '', injectInto: 'header', field: '', prefix: '',
}

function draftFrom(v: ProjectEnvVar): Draft {
  const rule = v.rule
  return {
    name: v.name,
    // A secret's value never comes back from the server, so an edit starts
    // empty and leaving it that way keeps the stored one.
    value: v.value ?? '',
    secret: v.secret,
    hosts: rule?.hosts.join(', ') ?? '',
    path: rule?.path ?? '',
    injectInto: rule?.bodyParam ? 'bodyParam' : 'header',
    field: rule?.bodyParam ?? rule?.header ?? '',
    prefix: rule?.prefix ?? '',
  }
}

function ruleFromDraft(draft: Draft): SecretProxyRule {
  const hosts = draft.hosts.split(/[\s,]+/).map((h) => h.trim()).filter((h) => h.length > 0)
  return {
    hosts,
    ...(draft.path.trim() ? { path: draft.path.trim() } : {}),
    ...(draft.injectInto === 'bodyParam'
      ? { bodyParam: draft.field.trim() }
      : draft.field.trim() ? { header: draft.field.trim() } : {}),
    ...(draft.prefix ? { prefix: draft.prefix } : {}),
  }
}

/**
 * A project's environment variables and proxied secrets.
 *
 * Stored with the project rather than in `yaac-config.json`, secrets
 * encrypted, which is what makes them settable from wherever the webapp is
 * open — a client on another machine has no way to put a value into the
 * server host's own environment.
 *
 * A secret's value is write-only: it goes in here and never comes back, so
 * an edit that leaves the field blank keeps whatever is stored.
 */
export function ProjectEnv({ slug, mediatedEgress }: {
  slug: string
  mediatedEgress: boolean
}): JSX.Element {
  const [vars, setVars] = useState<ProjectEnvVar[] | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setVars(await getProjectEnv(slug))
    } catch (e) {
      setError(errMessage(e))
    }
  }, [slug])

  useEffect(() => {
    setVars(null)
    setDraft(EMPTY)
    setEditing(null)
    setError(null)
    void refresh()
  }, [refresh])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await setProjectEnvVar(slug, {
        name: draft.name.trim(),
        // Omitted for a secret being edited without a new value, so the
        // server keeps the sealed one.
        ...(draft.secret && draft.value === '' ? {} : { value: draft.value }),
        secret: draft.secret,
        ...(draft.secret ? { rule: ruleFromDraft(draft) } : {}),
      })
      setDraft(EMPTY)
      setEditing(null)
      await refresh()
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (v: ProjectEnvVar): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await deleteProjectEnvVar(slug, v.id)
      if (editing === v.id) {
        setEditing(null)
        setDraft(EMPTY)
      }
      await refresh()
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const inputClass = 'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono '
    + 'text-xs text-text outline-none focus:border-border-strong'

  return (
    <div>
      <div className="text-xs font-medium text-text">Environment</div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Variables every worktree of this project starts with. Applies to worktrees
        created after saving.
      </p>

      {vars !== null && vars.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {vars.map((v) => (
            <div
              key={v.id}
              className="flex items-start justify-between gap-2 rounded-md bg-bg px-2.5 py-1.5 text-xs"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-text">{v.name}</span>
                  {v.secret && (
                    <span className="shrink-0 rounded bg-surface-3 px-1 text-[10px] text-text-dim">
                      secret
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-[11px] text-text-faint">
                  {v.secret
                    ? (v.hasValue ? '••••••••' : 'no value stored — enter one below')
                    : v.value}
                </div>
                {v.secret && (
                  <div className="truncate text-[11px] text-text-faint">{ruleSummary(v.rule)}</div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => { setEditing(v.id); setDraft(draftFrom(v)) }}
                  disabled={busy}
                  className="rounded-md bg-surface-3 px-2 py-0.5 text-[11px] text-text transition
                    hover:bg-border-strong disabled:opacity-50"
                >
                  Edit
                </button>
                <button
                  onClick={() => void remove(v)}
                  disabled={busy}
                  aria-label={`Delete ${v.name}`}
                  className="rounded-md p-1 text-text-faint transition hover:text-text disabled:opacity-50"
                >
                  <DeleteIcon size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={(e) => void submit(e)} className="mt-3 space-y-2">
        <div className="flex gap-2">
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="NAME"
            className={clsx(inputClass, 'flex-1')}
          />
          <input
            value={draft.value}
            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
            type={draft.secret ? 'password' : 'text'}
            placeholder={draft.secret && editing !== null ? 'unchanged' : 'value'}
            className={clsx(inputClass, 'flex-1')}
          />
        </div>

        <label className="flex items-center gap-1.5 text-[11px] text-text-dim">
          <input
            type="checkbox"
            checked={draft.secret}
            onChange={(e) => setDraft({ ...draft, secret: e.target.checked })}
          />
          Secret — stored encrypted
          {mediatedEgress
            ? ', injected into outbound requests by the proxy so it never enters the worktree'
            : '. This server runs worktrees on the host, with no proxy, so the value is placed in the worktree environment'}
        </label>

        {draft.secret && (
          <div className="space-y-2 rounded-md border border-border p-2">
            <input
              value={draft.hosts}
              onChange={(e) => setDraft({ ...draft, hosts: e.target.value })}
              placeholder="hosts to inject into, e.g. api.example.com, *.example.com"
              className={inputClass}
            />
            <div className="flex gap-2">
              <select
                value={draft.injectInto}
                onChange={(e) => setDraft({
                  ...draft,
                  injectInto: e.target.value === 'bodyParam' ? 'bodyParam' : 'header',
                })}
                className="rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-text
                  outline-none focus:border-border-strong"
              >
                <option value="header">Header</option>
                <option value="bodyParam">Body parameter</option>
              </select>
              <input
                value={draft.field}
                onChange={(e) => setDraft({ ...draft, field: e.target.value })}
                placeholder={draft.injectInto === 'header' ? 'authorization' : 'client_secret'}
                className={clsx(inputClass, 'flex-1')}
              />
            </div>
            <div className="flex gap-2">
              <input
                value={draft.path}
                onChange={(e) => setDraft({ ...draft, path: e.target.value })}
                placeholder="path (default /*)"
                className={clsx(inputClass, 'flex-1')}
              />
              {draft.injectInto === 'header' && (
                <input
                  value={draft.prefix}
                  onChange={(e) => setDraft({ ...draft, prefix: e.target.value })}
                  placeholder="prefix (default &quot;Bearer &quot;)"
                  className={clsx(inputClass, 'flex-1')}
                />
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
      </form>

      {error !== null && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  )
}
