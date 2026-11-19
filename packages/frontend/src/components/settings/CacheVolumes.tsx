import { useState, type FormEvent, type JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { DeleteIcon } from '#lib/icons'
import { api } from '#lib/api'
import { YButton, YInput, YRowFrame, YSettingRow } from '#ui'

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
    <YSettingRow
      stacked
      label="Cache volumes"
      hint={'Directories that persist across workspaces, such as a package manager\'s cache, each '
        + 'mounted at an absolute path in the workspace. Applies to workspaces created after saving.'}
    >
      {entries.length === 0 && <p className="text-md text-subtle">None</p>}
      <div className="divide-y divide-line">
        {entries.map(([key, path]) => (
          <YRowFrame
            key={key}
            label={key}
            actionsShown
            actions={!readOnly && (
              <YButton
                variant="ghost"
                size="sm"
                icon={DeleteIcon}
                onClick={() => save.mutate(Object.fromEntries(entries.filter(([k]) => k !== key)))}
                disabled={save.isPending}
                aria-label={`Remove ${key}`}
              />
            )}
            className="min-h-8 font-mono text-md"
          >
            <span className="shrink-0 text-text">{key}</span>
            <span className="flex-1 truncate text-subtle">{path}</span>
          </YRowFrame>
        ))}
      </div>

      {!readOnly && <form onSubmit={submit} className="mt-2 flex gap-2">
        <YInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="pip-cache"
          aria-label="Cache volume name"
          className="w-32 font-mono"
        />
        <YInput
          value={at}
          onChange={(e) => setAt(e.target.value)}
          placeholder="/home/yaac/.cache/pip"
          aria-label="Cache volume path"
          className="flex-1 font-mono"
        />
        <YButton
          type="submit"
          aria-label="Add cache volume"
          disabled={save.isPending || name.trim() === '' || at.trim() === ''}
        >
          Add
        </YButton>
      </form>}

      {save.error && <p className="mt-2 text-md text-danger">{save.error.message}</p>}
    </YSettingRow>
  )
}
