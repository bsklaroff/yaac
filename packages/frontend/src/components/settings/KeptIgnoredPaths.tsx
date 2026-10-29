import { useState, type FormEvent, type JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { DeleteIcon } from '#lib/icons'
import { api } from '#lib/api'
import { SectionLabel } from '#components/settings/Field'

const ROW = 'flex items-center gap-2 rounded-md bg-bg px-2.5 py-1.5 font-mono text-xs'

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
    <div>
      <SectionLabel>Kept ignored files</SectionLabel>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Stopping a workspace deletes every file your <code className="text-text-dim">.gitignore</code>{' '}
        matches, not only build output: <code className="text-text-dim">.env</code> files, local
        databases, editor and agent settings, and any new file in an ignored folder. Files git lists
        as untracked stay. List paths, relative to the repository root, to keep anyway: a file, or a
        folder and everything in it.
      </p>

      {paths.length > 0 && (
        <div className="mt-3 space-y-1">
          {paths.map((p) => (
            <div key={p} className={ROW}>
              <span className="flex-1 truncate text-text">{p}</span>
              {!readOnly && (
                <button
                  onClick={() => save.mutate(paths.filter((x) => x !== p))}
                  disabled={save.isPending}
                  aria-label={`Remove ${p}`}
                  className="shrink-0 text-text-faint transition hover:text-text disabled:opacity-50"
                >
                  <DeleteIcon size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!readOnly && <form onSubmit={submit} className="mt-3 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder=".env or data/dev.db"
          aria-label="Path to keep"
          className="flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text
            outline-none focus:border-border-strong"
        />
        <button
          type="submit"
          disabled={save.isPending || draft.trim() === ''}
          className="rounded-md bg-surface-3 px-3 py-1 text-xs font-medium text-text transition
            hover:bg-border-strong disabled:opacity-50"
        >
          Keep
        </button>
      </form>}

      {save.error && <p className="mt-2 text-xs text-red-400">{save.error.message}</p>}
    </div>
  )
}
