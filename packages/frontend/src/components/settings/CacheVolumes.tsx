import { useState, type FormEvent, type JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { DeleteIcon } from '#lib/icons'
import { api } from '#lib/api'
import { SectionLabel } from '#components/settings/Field'

const ROW = 'flex items-center gap-2 rounded-md bg-bg px-2.5 py-1.5 font-mono text-xs'
const INPUT = 'rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text outline-none focus:border-border-strong'

/**
 * A project's cache volumes: named directories that persist across its
 * workspaces, each mounted at an absolute path (docs/project-config.md).
 * k8s only. The list comes from the snapshot. `readOnly` (a teammate's
 * project) only lists them.
 */
export function CacheVolumes({ projectId, volumes, readOnly }: {
  projectId: string
  volumes: Record<string, string>
  readOnly: boolean
}): JSX.Element {
  const [name, setName] = useState('')
  const [at, setAt] = useState('')
  const save = useMutation({
    mutationFn: (next: Record<string, string>) =>
      api.project[':projectId']['cache-volumes'].$put({ param: { projectId }, json: { volumes: next } }),
  })
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    save.mutate({ ...volumes, [name.trim()]: at.trim() }, {
      onSuccess: () => { setName(''); setAt('') },
    })
  }
  const entries = Object.entries(volumes)

  return (
    <div>
      <SectionLabel>Cache volumes</SectionLabel>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Directories that persist across workspaces, such as a package manager&apos;s cache, each
        mounted at an absolute path in the workspace. Applies to workspaces created after saving.
      </p>

      <div className="mt-3 space-y-1">
        {entries.length === 0 && <div className={ROW}><span className="text-text-faint">None</span></div>}
        {entries.map(([key, path]) => (
          <div key={key} className={ROW}>
            <span className="shrink-0 text-text">{key}</span>
            <span className="flex-1 truncate text-text-faint">{path}</span>
            {!readOnly && (
              <button
                onClick={() => save.mutate(Object.fromEntries(entries.filter(([k]) => k !== key)))}
                disabled={save.isPending}
                aria-label={`Remove ${key}`}
                className="shrink-0 text-text-faint transition hover:text-text disabled:opacity-50"
              >
                <DeleteIcon size={12} />
              </button>
            )}
          </div>
        ))}
      </div>

      {!readOnly && <form onSubmit={submit} className="mt-3 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="pip-cache"
          aria-label="Cache volume name"
          className={`w-32 ${INPUT}`}
        />
        <input
          value={at}
          onChange={(e) => setAt(e.target.value)}
          placeholder="/home/yaac/.cache/pip"
          aria-label="Cache volume path"
          className={`flex-1 ${INPUT}`}
        />
        <button
          type="submit"
          aria-label="Add cache volume"
          disabled={save.isPending || name.trim() === '' || at.trim() === ''}
          className="rounded-md bg-surface-3 px-3 py-1 text-xs font-medium text-text transition
            hover:bg-border-strong disabled:opacity-50"
        >
          Add
        </button>
      </form>}

      {save.error && <p className="mt-2 text-xs text-red-400">{save.error.message}</p>}
    </div>
  )
}
