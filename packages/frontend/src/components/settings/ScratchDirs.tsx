import { useState, type FormEvent, type JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { DeleteIcon } from '#lib/icons'
import { api } from '#lib/api'
import { SectionLabel } from '#components/settings/Field'
import { NumberInput } from '#components/ui/NumberInput'
import { TEXT_BUTTON } from '#components/ui/button'
import { DEFAULT_SCRATCH_DIR_GIB, type ScratchDirSettings } from '@yaac/shared/types'

const ROW = 'flex items-center gap-2 rounded-md bg-bg px-2.5 py-1.5 font-mono text-xs'

/** A cap in GiB, edited freely and handed to `onSave` once it leaves the
 *  field changed: a whole number, or empty (undefined) for the default. */
function SizeField({ path, value, disabled, onSave }: {
  path: string
  value: number | undefined
  disabled: boolean
  onSave: (sizeGiB: number | undefined) => void
}): JSX.Element {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))
  const commit = (): void => {
    const n = draft.trim() === '' ? undefined : Number(draft)
    if (n === value) return
    if (n === undefined || (Number.isInteger(n) && n >= 1)) onSave(n)
    else setDraft(value === undefined ? '' : String(value))
  }
  return (
    <span className="flex shrink-0 items-center gap-1 font-sans text-[11px] text-text-faint">
      <NumberInput
        aria-label={`Cap of ${path} in GiB`}
        min={1}
        max={1024}
        placeholder={String(DEFAULT_SCRATCH_DIR_GIB)}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        className="h-6 w-16 bg-surface-2"
      />
      GiB
    </span>
  )
}

/**
 * A project's scratch directories, each with its cap (docs/workspace-storage.md
 * "Package installs"), and the tracked ones it no longer warns about, each of
 * which can be warned about again. Values come from the snapshot, which the
 * server pushes again once they change. `readOnly` (a teammate's project)
 * only lists them.
 */
export function ScratchDirs({ projectId, settings, readOnly }: {
  projectId: string
  settings: ScratchDirSettings
  readOnly: boolean
}): JSX.Element {
  const { dirs, ignoredTracked } = settings
  const [draft, setDraft] = useState('')
  const [draftSize, setDraftSize] = useState('')
  const save = useMutation({
    mutationFn: (json: Partial<ScratchDirSettings>) =>
      api.project[':projectId']['scratch-dirs'].$put({ param: { projectId }, json }),
  })
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const path = draft.trim()
    save.mutate({ dirs: [...dirs, draftSize.trim() === '' ? { path } : { path, sizeGiB: Number(draftSize) }] }, {
      onSuccess: () => { setDraft(''); setDraftSize('') },
    })
  }

  return (
    <div>
      <SectionLabel>Scratch directories</SectionLabel>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Directories of installed packages and build output, relative to the checkout. Each
        workspace keeps its own, off the shared checkout, and they are emptied when it stops;
        its init commands rebuild them. Under k8s each holds at most its cap, {DEFAULT_SCRATCH_DIR_GIB} GiB
        unless set, and a write past it fails. Applies to workspaces started after saving.
      </p>

      <div className="mt-3 space-y-1">
        {dirs.length === 0 && <div className={ROW}><span className="text-text-faint">None</span></div>}
        {dirs.map((d) => (
          <div key={d.path} className={ROW}>
            <span className="flex-1 truncate text-text">{d.path}/</span>
            {readOnly
              ? (
                <span className="shrink-0 font-sans text-[11px] text-text-faint">
                  {d.sizeGiB ?? `${DEFAULT_SCRATCH_DIR_GIB}`} GiB{d.sizeGiB === undefined && ' (default)'}
                </span>
              )
              : (
                <>
                  <SizeField
                    key={d.sizeGiB ?? 'default'}
                    path={d.path}
                    value={d.sizeGiB}
                    disabled={save.isPending}
                    onSave={(sizeGiB) => save.mutate({
                      dirs: dirs.map((x) => (x.path !== d.path ? x : sizeGiB === undefined ? { path: x.path } : { path: x.path, sizeGiB })),
                    })}
                  />
                  <button
                    onClick={() => save.mutate({ dirs: dirs.filter((x) => x.path !== d.path) })}
                    disabled={save.isPending}
                    aria-label={`Remove ${d.path}`}
                    className="shrink-0 text-text-faint transition hover:text-text disabled:opacity-50"
                  >
                    <DeleteIcon size={12} />
                  </button>
                </>
              )}
          </div>
        ))}
      </div>

      {!readOnly && <form onSubmit={submit} className="mt-3 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="packages/web/node_modules"
          className="flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text
            outline-none focus:border-border-strong"
        />
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-text-faint">
          <NumberInput
            aria-label="Cap of the new directory in GiB"
            min={1}
            max={1024}
            placeholder={String(DEFAULT_SCRATCH_DIR_GIB)}
            value={draftSize}
            onChange={(e) => setDraftSize(e.target.value)}
            className="h-full w-16 bg-bg"
          />
          GiB
        </span>
        <button
          type="submit"
          aria-label="Add scratch directory"
          disabled={save.isPending || draft.trim() === ''}
          className="rounded-md bg-surface-3 px-3 py-1 text-xs font-medium text-text transition
            hover:bg-border-strong disabled:opacity-50"
        >
          Add
        </button>
      </form>}

      {ignoredTracked.length > 0 && (
        <div className="mt-3 text-[11px] text-text-faint">
          Not warned about when tracked in git:
          {ignoredTracked.map((p) => (
            <span key={p} className="ml-2 inline-flex items-center">
              <code className="font-mono text-text-dim">{p}/</code>
              {!readOnly && (
                <button
                  type="button"
                  disabled={save.isPending}
                  onClick={() => save.mutate({ ignoredTracked: ignoredTracked.filter((x) => x !== p) })}
                  className={TEXT_BUTTON}
                >
                  Warn again
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {save.error && <p className="mt-2 text-xs text-red-400">{save.error.message}</p>}
    </div>
  )
}
