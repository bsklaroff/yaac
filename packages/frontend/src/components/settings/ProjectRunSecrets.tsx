import { useState, type FormEvent, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { DeleteIcon } from '#lib/icons'
import { api } from '#lib/api'
import { SectionLabel } from '#components/settings/Field'
import type { ProjectRunSecret } from '@yaac/shared/types'

interface Draft {
  name: string
  value: string
}

const EMPTY: Draft = { name: '', value: '' }

/** A project's run secrets, also offered to its workflows. */
export function useRunSecrets(projectId: string): UseQueryResult<ProjectRunSecret[]> {
  return useQuery({
    queryKey: ['project-run-secrets', projectId],
    queryFn: async () => (await api.project[':projectId']['run-secrets'].$get({ param: { projectId } })).secrets,
    staleTime: 0,
  })
}

/**
 * A project's run secrets (docs/project-config.md "Run secrets"): values
 * that only the workflow revisions naming them get, as they are
 * (docs/workflows.md). A value is write-only, so an edit sets a new one.
 * `readOnly` (a teammate's project) only lists them.
 */
export function ProjectRunSecrets({ projectId, readOnly }: { projectId: string; readOnly: boolean }): JSX.Element {
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [editing, setEditing] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const queryKey = ['project-run-secrets', projectId]
  const { data: secrets, error: loadError } = useRunSecrets(projectId)

  const save = useMutation({
    mutationFn: () => api.project[':projectId']['run-secrets'].$put({
      param: { projectId },
      json: { name: draft.name.trim(), value: draft.value },
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
  const inputClass = 'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono '
    + 'text-xs text-text outline-none focus:border-border-strong'

  return (
    <div>
      <SectionLabel>Run secrets</SectionLabel>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Real values, kept apart from the secrets above, that reach a workspace's environment only
        through a workflow that names them, on a commit you ran it on. Interactive workspaces never
        get them.
      </p>

      {secrets !== undefined && secrets.length > 0 && <div className="mt-3 space-y-1">
        {secrets.map((r) => (
          <div
            key={r.id}
            className={clsx('flex items-center gap-2 rounded-md bg-bg px-2.5 py-1.5 font-mono text-xs',
              editing === r.id && 'ring-1 ring-accent-soft')}
          >
            <button
              onClick={() => { setEditing(r.id); setDraft({ name: r.name, value: '' }) }}
              disabled={readOnly || busy}
              title={readOnly ? undefined : `Edit ${r.name}`}
              className={clsx('flex min-w-0 flex-1 items-center gap-3 text-left', !readOnly && 'transition hover:opacity-80')}
            >
              <span className="max-w-[50%] shrink-0 truncate text-text">{r.name}</span>
              <span className={clsx('shrink-0', r.hasValue ? 'text-text-faint' : 'font-sans text-[11px] text-error')}>
                {r.hasValue ? '••••••••' : 'no value stored'}
              </span>
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
            placeholder={editing !== null ? 'new value' : 'secret value'}
            aria-label="Run secret value"
            className={clsx(inputClass, 'min-w-0 flex-1')}
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={busy || draft.name.trim() === '' || draft.value === ''}
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
