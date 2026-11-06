import { useState, type FormEvent, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DeleteIcon } from '#lib/icons'
import { api } from '#lib/api'
import { useSnapshot } from '#lib/useSnapshot'
import { SectionLabel } from '#components/settings/Field'
import type { ProjectRunSecret } from '@yaac/shared/types'

interface Draft {
  name: string
  value: string
  siteIds: string[]
  routineIds: string[]
}

const EMPTY: Draft = { name: '', value: '', siteIds: [], routineIds: [] }

/**
 * A project's run secrets (docs/project-config.md "Run secrets"): values
 * that only the sites and routines each one names get, as they are. A
 * value is write-only, so leaving it blank in an edit keeps the stored one.
 * Only a non-interactive routine pinned to a commit may be named, since a
 * branch's tip is whatever was last pushed. `hasSites` is false where the
 * server has none (containerless); `readOnly` (a teammate's project) only
 * lists them.
 */
export function ProjectRunSecrets({ projectId, hasSites, readOnly }: {
  projectId: string
  hasSites: boolean
  readOnly: boolean
}): JSX.Element {
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [editing, setEditing] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const queryKey = ['project-run-secrets', projectId]
  const { data: secrets, error: loadError } = useQuery({
    queryKey,
    queryFn: async () => (await api.project[':projectId']['run-secrets'].$get({ param: { projectId } })).secrets,
    staleTime: 0,
  })
  // The same query the Sites section reads.
  const { data: sites } = useQuery({
    queryKey: ['sites', projectId],
    queryFn: () => api.site.list.$get({ query: { project: projectId } }),
    enabled: hasSites,
  })
  const routines = (useSnapshot()?.routines ?? []).filter((r) => r.projectId === projectId)

  const save = useMutation({
    mutationFn: () => api.project[':projectId']['run-secrets'].$put({
      param: { projectId },
      json: {
        name: draft.name.trim(),
        ...(draft.value === '' ? {} : { value: draft.value }),
        siteIds: draft.siteIds,
        routineIds: draft.routineIds,
      },
    }),
    onSuccess: () => { setDraft(EMPTY); setEditing(null) },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })
  const remove = useMutation({
    mutationFn: (r: ProjectRunSecret) => api.project[':projectId']['run-secrets'][':id'].$delete({ param: { projectId, id: r.id } }),
    onSuccess: (_, r) => { if (editing === r.id) { setEditing(null); setDraft(EMPTY) } },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })
  const busy = save.isPending || remove.isPending
  const error = save.error ?? remove.error ?? loadError

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    remove.reset()
    save.mutate()
  }
  const toggle = (list: string[], id: string): string[] => list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
  const targets = (r: ProjectRunSecret): string => [
    ...r.siteIds.map((id) => `site ${sites?.find((s) => s.id === id)?.name ?? id.slice(0, 8)}`),
    ...r.routineIds.map((id) => `routine ${routines.find((x) => x.id === id)?.name ?? id.slice(0, 8)}`),
  ].join(', ') || 'given to nothing'
  // A routine already named stays listed, so unticking it is possible.
  const eligible = routines.filter((r) => (r.nonInteractive === true && r.commit !== undefined) || draft.routineIds.includes(r.id))
  const inputClass = 'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono '
    + 'text-xs text-text outline-none focus:border-border-strong'
  const checkbox = (label: string, checked: boolean, onChange: () => void): JSX.Element => (
    <label key={label} className="flex items-center gap-2 text-[11px] text-text">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="truncate">{label}</span>
    </label>
  )

  return (
    <div>
      <SectionLabel>Run secrets</SectionLabel>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Real values, kept apart from the secrets above, that only the sites and routines you
        name get in their environment. Interactive workspaces, reruns and agents never see them.
        A routine must be non-interactive and start at a commit.
      </p>

      {secrets !== undefined && secrets.length > 0 && <div className="mt-3 space-y-1">
        {secrets.map((r) => (
          <div
            key={r.id}
            className={clsx('flex items-center gap-2 rounded-md bg-bg px-2.5 py-1.5 font-mono text-xs',
              editing === r.id && 'ring-1 ring-accent-soft')}
          >
            <button
              onClick={() => { setEditing(r.id); setDraft({ name: r.name, value: '', siteIds: r.siteIds, routineIds: r.routineIds }) }}
              disabled={readOnly || busy}
              title={readOnly ? undefined : `Edit ${r.name}`}
              className={clsx('flex min-w-0 flex-1 items-center gap-3 text-left', !readOnly && 'transition hover:opacity-80')}
            >
              <span className="max-w-[40%] shrink-0 truncate text-text">{r.name}</span>
              <span className={clsx('shrink-0', r.hasValue ? 'text-text-faint' : 'font-sans text-[11px] text-error')}>
                {r.hasValue ? '••••••••' : 'no value stored'}
              </span>
              <span className="min-w-0 flex-1 truncate text-right font-sans text-[11px] text-accent">{targets(r)}</span>
            </button>
            {!readOnly && <button
              onClick={() => { save.reset(); remove.mutate(r) }}
              disabled={busy}
              aria-label={`Delete ${r.name}`}
              className="shrink-0 text-text-faint transition hover:text-text disabled:opacity-50"
            >
              <DeleteIcon size={12} />
            </button>}
          </div>
        ))}
      </div>}

      {readOnly && secrets?.length === 0 && <p className="mt-3 text-[11px] text-text-faint">None set.</p>}

      {!readOnly && <form onSubmit={submit} className="mt-3 space-y-2">
        <div className="flex gap-2">
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="SECRET_NAME"
            aria-label="Run secret name"
            className={clsx(inputClass, 'min-w-0 flex-1')}
          />
          <input
            value={draft.value}
            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
            type="password"
            placeholder={editing !== null ? 'unchanged' : 'secret value'}
            aria-label="Run secret value"
            className={clsx(inputClass, 'min-w-0 flex-1')}
          />
        </div>
        {(sites?.length ?? 0) + eligible.length > 0
          ? <div className="space-y-1 rounded-md border border-border p-2">
            {sites?.map((s) => checkbox(`site ${s.name}`, draft.siteIds.includes(s.id),
              () => setDraft({ ...draft, siteIds: toggle(draft.siteIds, s.id) })))}
            {eligible.map((r) => checkbox(`routine ${r.name}`, draft.routineIds.includes(r.id),
              () => setDraft({ ...draft, routineIds: toggle(draft.routineIds, r.id) })))}
          </div>
          : <p className="text-[11px] text-text-faint">
            No {hasSites ? 'site or ' : ''}non-interactive routine at a commit to give it to yet.
          </p>}
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={busy || draft.name.trim() === ''}
            className="rounded-md bg-surface-3 px-3 py-1 text-xs font-medium text-text transition
              hover:bg-border-strong disabled:opacity-50"
          >
            {editing !== null ? 'Save run secret' : 'Add run secret'}
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
