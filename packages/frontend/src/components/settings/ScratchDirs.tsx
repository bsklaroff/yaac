import { useState, type FormEvent, type JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { DeleteIcon } from '#lib/icons'
import { api } from '#lib/api'
import type { ScratchDirSettings } from '@yaac/shared/types'
import { YButton, YInput, YNumberInput, YRowFrame, YSettingRow } from '#ui'

/** The scratch size in GiB, edited freely and handed to `onSave` once it
 *  leaves the field changed to a whole number. */
function SizeField({ value, disabled, onSave }: {
  value: number
  disabled: boolean
  onSave: (sizeGiB: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  const commit = (): void => {
    const n = Number(draft)
    if (n === value) return
    if (Number.isInteger(n) && n >= 1 && n <= 1024) onSave(n)
    else setDraft(String(value))
  }
  return (
    <span className="flex shrink-0 items-center gap-1 font-sans text-sm text-subtle">
      <YNumberInput
        aria-label="What the scratch directories may hold together, in GiB"
        min={1}
        max={1024}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        className="h-6 w-16 bg-selected"
      />
      GiB together
    </span>
  )
}

/**
 * A project's scratch directories and what they may hold together
 * (docs/workspace-storage.md "Package installs"), and the tracked ones it no
 * longer warns about, each of which can be warned about again. Values come
 * from the snapshot, which the server pushes again once they change.
 * `readOnly` (a teammate's project) only lists them.
 */
export function ScratchDirs({ projectId, settings, readOnly }: {
  projectId: string
  settings: ScratchDirSettings
  readOnly: boolean
}): JSX.Element {
  const { dirs, sizeGiB, ignoredTracked } = settings
  const [draft, setDraft] = useState('')
  const save = useMutation({
    mutationFn: (json: Partial<ScratchDirSettings>) =>
      api.project[':projectId']['scratch-dirs'].$put({ param: { projectId }, json }),
  })
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const path = draft.trim()
    save.mutate({ dirs: [...dirs, { path }] }, {
      onSuccess: () => { setDraft('') },
    })
  }

  return (
    <YSettingRow
      stacked
      label="Scratch directories"
      hint={<>
        Directories of installed packages and build output, relative to the checkout. Each
        workspace keeps its own, off the shared checkout, and they are emptied when it stops;
        its init steps rebuild them. Under k8s they hold at most this much together, and a write
        past it fails. Applies to workspaces started after saving.
      </>}
    >
      {readOnly
        ? <p className="text-sm text-subtle">{sizeGiB} GiB together</p>
        : <SizeField key={sizeGiB} value={sizeGiB} disabled={save.isPending} onSave={(n) => save.mutate({ sizeGiB: n })} />}
      {dirs.length === 0 && <p className="text-md text-subtle">None</p>}
      <div className="divide-y divide-line">
        {dirs.map((d) => (
          <YRowFrame
            key={d.path}
            label={`${d.path}/`}
            actionsShown
            actions={!readOnly && (
              <YButton
                variant="ghost"
                size="sm"
                icon={DeleteIcon}
                onClick={() => save.mutate({ dirs: dirs.filter((x) => x.path !== d.path) })}
                disabled={save.isPending}
                aria-label={`Remove ${d.path}`}
              />
            )}
            className="min-h-8 font-mono text-md"
          >
            <span className="flex-1 truncate text-text">{d.path}/</span>
          </YRowFrame>
        ))}
      </div>

      {!readOnly && <form onSubmit={submit} className="mt-2 flex gap-2">
        <YInput
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="packages/web/node_modules"
          className="flex-1 font-mono"
        />
        <YButton type="submit" aria-label="Add scratch directory" disabled={save.isPending || draft.trim() === ''}>
          Add
        </YButton>
      </form>}

      {ignoredTracked.length > 0 && (
        <div className="mt-2 text-sm text-subtle">
          Not warned about when tracked in git:
          {ignoredTracked.map((p) => (
            <span key={p} className="ml-2 inline-flex items-center">
              <code className="font-mono text-muted">{p}/</code>
              {!readOnly && (
                <YButton
                  variant="secondary"
                  size="sm"
                  disabled={save.isPending}
                  onClick={() => save.mutate({ ignoredTracked: ignoredTracked.filter((x) => x !== p) })}
                >
                  Warn again
                </YButton>
              )}
            </span>
          ))}
        </div>
      )}

      {save.error && <p className="mt-2 text-md text-danger">{save.error.message}</p>}
    </YSettingRow>
  )
}
