import { useState, type FormEvent, type JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { DeleteIcon } from '#lib/icons'
import { api } from '#lib/api'
import { YButton, YInput, YRowFrame, YSettingRow } from '#ui'

/**
 * The gitignored paths a project's stopped workspaces keep: a stop removes
 * every other ignored file from the checkout (docs/workspace-storage.md
 * "Ignored files at stop"). The list comes from the snapshot, which the
 * server pushes again once it changes. `readOnly` (a teammate's project)
 * only lists them.
 */
export function KeptIgnoredPaths({ projectId, paths, readOnly }: {
  projectId: string
  paths: string[]
  readOnly: boolean
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const save = useMutation({
    mutationFn: (next: string[]) => api.project[':projectId']['kept-ignored-paths'].$put({
      param: { projectId },
      json: { paths: next },
    }),
    onSuccess: () => setDraft(''),
  })

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    save.mutate([...paths, draft.trim()])
  }

  return (
    <YSettingRow
      stacked
      label="Kept ignored files"
      hint={<>
        Stopping a workspace deletes every file your <code className="text-muted">.gitignore</code>{' '}
        matches, not only build output: <code className="text-muted">.env</code> files, local
        databases, editor and agent settings, and any new file in an ignored folder. Files git lists
        as untracked stay. List paths, relative to the repository root, to keep anyway: a file, or a
        folder and everything in it.
      </>}
    >
      {paths.length > 0 && (
        <div className="mb-2 divide-y divide-line">
          {paths.map((p) => (
            <YRowFrame
              key={p}
              label={p}
              actionsShown
              actions={!readOnly && (
                <YButton
                  variant="ghost"
                  size="sm"
                  icon={DeleteIcon}
                  onClick={() => save.mutate(paths.filter((x) => x !== p))}
                  disabled={save.isPending}
                  aria-label={`Remove ${p}`}
                />
              )}
              className="min-h-8 font-mono text-md"
            >
              <span className="flex-1 truncate text-text">{p}</span>
            </YRowFrame>
          ))}
        </div>
      )}

      {!readOnly && <form onSubmit={submit} className="flex gap-2">
        <YInput
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder=".env or data/dev.db"
          aria-label="Path to keep"
          className="flex-1 font-mono"
        />
        <YButton type="submit" disabled={save.isPending || draft.trim() === ''}>
          Keep
        </YButton>
      </form>}

      {save.error && <p className="mt-2 text-md text-danger">{save.error.message}</p>}
    </YSettingRow>
  )
}
