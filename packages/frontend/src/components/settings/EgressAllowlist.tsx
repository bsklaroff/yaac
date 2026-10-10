import { useState, type FormEvent, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronIcon, DeleteIcon } from '#lib/icons'
import { api } from '#lib/api'
import { SectionLabel } from '#components/settings/Field'
import type { EgressAllowlist as Allowlist } from '@yaac/shared/types'

const ROW = 'flex items-center gap-2 rounded-md bg-bg px-2.5 py-1.5 font-mono text-xs'

function Dot({ allowed }: { allowed: boolean }): JSX.Element {
  return <span className={clsx('size-1.5 shrink-0 rounded-full', allowed ? 'bg-success' : 'bg-error')} />
}

/**
 * The hosts a project's workspaces may reach through the egress proxy: the
 * install's defaults (collapsed, since there are hundreds), the project's own
 * additions, and a closing row for everything else. Only shown on a server
 * with mediated egress. `readOnly` (a teammate's project) only lists them.
 */
export function EgressAllowlist({ projectId, readOnly = false }: {
  projectId: string
  readOnly?: boolean
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [showDefaults, setShowDefaults] = useState(false)
  const queryClient = useQueryClient()
  const queryKey = ['project-allowlist', projectId]
  const { data, error: loadError } = useQuery({
    queryKey,
    queryFn: async () => await api.project[':projectId'].allowlist.$get({ param: { projectId } }),
    staleTime: 0,
  })

  const save = useMutation({
    mutationFn: (next: Allowlist) =>
      api.project[':projectId'].allowlist.$put({ param: { projectId }, json: next }),
    onSuccess: () => setDraft(''),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!data) return
    save.mutate({ ...data.allowlist, hosts: [...data.allowlist.hosts, draft.trim()] })
  }

  const allowlist = data?.allowlist
  const everything = allowlist?.hosts.includes('*') ?? false
  const label = 'shrink-0 text-[11px] font-sans'

  return (
    <div>
      <SectionLabel>Egress allowlist</SectionLabel>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Hosts this project&apos;s workspaces may reach. Exact names or{' '}
        <code className="text-text-dim">*.example.com</code> wildcards; <code className="text-text-dim">*</code>{' '}
        allows everything. Applies to workspaces created after saving.
      </p>

      {data && allowlist && (
        <div className="mt-3 space-y-1">
          <button
            type="button"
            onClick={() => setShowDefaults(!showDefaults)}
            className={clsx(ROW, 'w-full text-left transition hover:bg-surface-2')}
          >
            <Dot allowed={allowlist.defaults} />
            <span className={clsx('flex-1 truncate', allowlist.defaults ? 'text-text' : 'text-text-faint')}>
              {data.defaultHosts.length} default hosts
            </span>
            <ChevronIcon size={12} className={clsx('text-text-faint transition', showDefaults && 'rotate-90')} />
            <span className={clsx(label, allowlist.defaults ? 'text-text-faint' : 'text-error')}>
              {allowlist.defaults ? 'default' : 'blocked'}
            </span>
          </button>
          {showDefaults && (
            <div className="max-h-48 space-y-1 overflow-y-auto pl-3">
              {data.defaultHosts.map((h) => (
                <div key={h} className={ROW}>
                  <Dot allowed={allowlist.defaults} />
                  <span className={clsx('flex-1 truncate', allowlist.defaults ? 'text-text' : 'text-text-faint')}>{h}</span>
                </div>
              ))}
            </div>
          )}

          {allowlist.hosts.map((h) => (
            <div key={h} className={ROW}>
              <Dot allowed />
              <span className="flex-1 truncate text-text">{h === '*' ? '* (everything)' : h}</span>
              <span className={clsx(label, 'text-text-faint')}>added</span>
              {!readOnly && (
                <button
                  onClick={() => save.mutate({ ...allowlist, hosts: allowlist.hosts.filter((x) => x !== h) })}
                  disabled={save.isPending}
                  aria-label={`Remove ${h}`}
                  className="shrink-0 text-text-faint transition hover:text-text disabled:opacity-50"
                >
                  <DeleteIcon size={12} />
                </button>
              )}
            </div>
          ))}

          <div className={ROW}>
            <Dot allowed={everything} />
            <span className="flex-1 truncate text-text-faint">everything else</span>
            <span className={clsx(label, everything ? 'text-text-faint' : 'text-error')}>
              {everything ? 'allowed' : 'blocked'}
            </span>
          </div>
        </div>
      )}

      {!readOnly && allowlist && <form onSubmit={submit} className="mt-3 space-y-2">
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="api.example.com or *.example.com"
            className="flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text
              outline-none focus:border-border-strong"
          />
          <button
            type="submit"
            disabled={save.isPending || draft.trim() === ''}
            className="rounded-md bg-surface-3 px-3 py-1 text-xs font-medium text-text transition
              hover:bg-border-strong disabled:opacity-50"
          >
            Add
          </button>
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-text-dim">
          <input
            type="checkbox"
            checked={allowlist.defaults}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ ...allowlist, defaults: e.target.checked })}
          />
          Allow the default hosts (agent APIs, GitHub, package registries)
        </label>
      </form>}

      {(save.error ?? loadError) && <p className="mt-2 text-xs text-red-400">{(save.error ?? loadError)?.message}</p>}
    </div>
  )
}
