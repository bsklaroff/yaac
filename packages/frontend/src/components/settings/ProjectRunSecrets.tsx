import { useState, type FormEvent, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { DeleteIcon } from '#lib/icons'
import { api } from '#lib/api'
import type { ProjectRunSecret } from '@yaac/shared/types'
import { YButton, YInput, YSettingRow } from '#ui'

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

  return (
    <YSettingRow
      stacked
      label="Run secrets"
      hint={'Real values, kept apart from the secrets above, that reach a workspace\'s environment only '
        + 'through a workflow that names them, on commits you approved it for by running it. Interactive '
        + 'workspaces never get them. A value under 8 characters cannot be masked in step logs.'}
    >
      {secrets !== undefined && secrets.length > 0 && <div className="mb-2 divide-y divide-line">
        {secrets.map((r) => (
          <div
            key={r.id}
            className={clsx('flex min-h-8 items-center gap-2 font-mono text-md',
              editing === r.id ? 'bg-selected' : !readOnly && 'hover:bg-hover')}
          >
            <YButton
              variant="bare"
              onClick={() => { setEditing(r.id); setDraft({ name: r.name, value: '' }) }}
              disabled={readOnly || busy}
              title={readOnly ? undefined : `Edit ${r.name}`}
              className="flex min-h-8 min-w-0 flex-1 items-center gap-3 self-stretch text-left disabled:opacity-100"
            >
              <span className="max-w-[50%] shrink-0 truncate text-text">{r.name}</span>
              <span className={clsx('shrink-0', r.hasValue ? 'text-subtle' : 'font-sans text-sm text-danger')}>
                {r.hasValue ? '••••••••' : 'no value stored'}
              </span>
            </YButton>
            {!readOnly && <YButton
              variant="ghost"
              size="sm"
              icon={DeleteIcon}
              onClick={() => { save.reset(); remove.mutate(r) }}
              disabled={busy}
              aria-label={`Delete ${r.name}`}
            />}
          </div>
        ))}
      </div>}

      {readOnly && secrets?.length === 0 && <p className="text-md text-subtle">None set.</p>}

      {!readOnly && <form onSubmit={submit} className="space-y-2">
        <div className="flex gap-2">
          <YInput
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="SECRET_NAME"
            aria-label="Run secret name"
            className="flex-1 font-mono"
          />
          <YInput
            value={draft.value}
            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
            type="password"
            placeholder={editing !== null ? 'new value' : 'secret value'}
            aria-label="Run secret value"
            className="flex-1 font-mono"
          />
        </div>
        <div className="flex items-center gap-2">
          <YButton type="submit" disabled={busy || draft.name.trim() === '' || draft.value === ''}>
            {editing !== null ? 'Save run secret' : 'Add run secret'}
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
