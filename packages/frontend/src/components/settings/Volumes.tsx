import { useState, type FormEvent, type JSX } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '#lib/api'
import { DeleteIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'
import { relativeAge } from '#lib/time'
import { useVolumes, volumesKey } from '#lib/volumes'
import { SectionLabel } from '#components/settings/Field'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { BUTTON, TEXT_BUTTON } from '#components/ui/button'
import type { VolumeEntry } from '@yaac/shared/types'

export const INPUT = 'rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text outline-none '
  + 'placeholder:text-text-faint focus:border-border-strong'

/**
 * A project's workspace volumes (docs/workspace-volumes.md): each
 * one's size, the running workspace it is attached to and since when, and
 * the stopped workspaces that attach it again on restart, each linked. Only
 * shown on a cluster. Create, resize and delete each refetch the list;
 * `readOnly` (a teammate's project) only lists them.
 */
export function Volumes({ projectId, readOnly }: { projectId: string; readOnly: boolean }): JSX.Element {
  const volumes = useVolumes(projectId)
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [size, setSize] = useState('')
  // The volume whose size box is open, and the one Delete was pressed for.
  const [resizing, setResizing] = useState<{ name: string; size: string } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const onSettled = (): Promise<void> => queryClient.invalidateQueries({ queryKey: volumesKey(projectId) })

  const create = useMutation({
    mutationFn: () => api.volume.create.$post({
      json: { project: projectId, name: name.trim(), ...(size.trim() !== '' ? { size: size.trim() } : {}) },
    }),
    onSuccess: () => { setName(''); setSize('') },
    onSettled,
  })
  const resize = useMutation({
    mutationFn: (r: { name: string; size: string }) =>
      api.volume.resize.$post({ json: { project: projectId, name: r.name, size: r.size.trim() } }),
    onSuccess: () => setResizing(null),
    onSettled,
  })
  const remove = useMutation({
    mutationFn: (volume: string) => api.volume.delete.$post({ json: { project: projectId, name: volume } }),
    onSuccess: () => setDeleting(null),
    onSettled,
  })

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    create.mutate()
  }
  const error = create.error ?? resize.error

  return (
    <div>
      <SectionLabel>Volumes</SectionLabel>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Named storage that outlives any one workspace, for data an app keeps between runs. One
        running workspace at a time attaches a volume, picked when it is created, and sees it at{' '}
        <code className="text-text-dim">$YAAC_VOLUME_DIR</code>. A stopped workspace attaches its
        volume again when restarted. The size is enforced only where the cluster gives each volume
        its own disk.
      </p>

      {volumes !== undefined && (
        <div className="mt-3 space-y-1">
          {volumes.map((v) => (
            <VolumeRow
              key={v.name}
              projectId={projectId}
              volume={v}
              readOnly={readOnly}
              resizing={resizing?.name === v.name ? resizing.size : null}
              onResizing={(s) => { resize.reset(); setResizing(s === null ? null : { name: v.name, size: s }) }}
              onResize={() => { if (resizing) resize.mutate(resizing) }}
              resizePending={resize.isPending}
              onDelete={() => { remove.reset(); setDeleting(v.name) }}
            />
          ))}
          {volumes.length === 0 && <p className="text-[11px] text-text-faint">No volumes yet.</p>}
        </div>
      )}

      {!readOnly && (
        <form onSubmit={submit} className="mt-3 flex gap-2">
          <input
            aria-label="Volume name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name (a-z, 0-9, -)"
            maxLength={40}
            className={`${INPUT} min-w-0 flex-1`}
          />
          <input
            aria-label="Volume size"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            placeholder="10Gi"
            className={`${INPUT} w-20`}
          />
          <button type="submit" disabled={create.isPending || name.trim() === ''} className={BUTTON}>
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </form>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error.message}</p>}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) setDeleting(null) }}
        title={`Delete volume “${deleting ?? ''}”?`}
        description="Its data is deleted for good. Stopped workspaces that had it restart without it."
        busy={remove.isPending}
        error={remove.error?.message}
        onConfirm={() => { if (deleting !== null) remove.mutate(deleting) }}
      />
    </div>
  )
}

/** One volume, with its own size box while `resizing` holds its text. */
function VolumeRow({ projectId, volume, readOnly, resizing, onResizing, onResize, resizePending, onDelete }: {
  projectId: string
  volume: VolumeEntry
  readOnly: boolean
  resizing: string | null
  onResizing: (size: string | null) => void
  onResize: () => void
  resizePending: boolean
  onDelete: () => void
}): JSX.Element {
  const { holder, stoppedWorkspaces } = volume
  return (
    <div className="rounded-md bg-bg px-2.5 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate font-mono text-text">{volume.name}</span>
        {resizing === null ? (
          <span className="shrink-0 font-mono text-[11px] text-text-faint">{volume.size}</span>
        ) : (
          <input
            autoFocus
            aria-label={`New size of ${volume.name}`}
            value={resizing}
            onChange={(e) => onResizing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onResize()
              if (e.key === 'Escape') onResizing(null)
            }}
            className={`${INPUT} h-6 w-20 py-0`}
          />
        )}
        {!readOnly && (resizing === null ? (
          <button type="button" onClick={() => onResizing(volume.size)} className={TEXT_BUTTON}>Resize</button>
        ) : (
          <>
            <button type="button" onClick={onResize} disabled={resizePending} className={TEXT_BUTTON}>Save</button>
            <button type="button" onClick={() => onResizing(null)} className={TEXT_BUTTON}>Cancel</button>
          </>
        ))}
        {!readOnly && (
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete volume ${volume.name}`}
            className="shrink-0 text-text-faint transition hover:text-text"
          >
            <DeleteIcon size={12} />
          </button>
        )}
      </div>
      <div className="mt-0.5 text-[11px] text-text-faint">
        {holder !== undefined ? (
          <>
            Attached to running <WorkspaceLink projectId={projectId} {...holder} />{' '}
            <span title={new Date(holder.attachedAt).toLocaleString()}>{relativeAge(holder.attachedAt)}</span>
          </>
        ) : 'Free'}
        {stoppedWorkspaces.length > 0 && (
          <>
            {' · restarts with it: '}
            {stoppedWorkspaces.map((w, i) => (
              <span key={w.workspaceId}>
                {i > 0 && ', '}
                <WorkspaceLink projectId={projectId} {...w} />
              </span>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

/** A workspace's title (or short id), opening it in place of settings. */
export function WorkspaceLink({ projectId, workspaceId, title }: {
  projectId: string
  workspaceId: string
  title?: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => {
        const st = useUiStore.getState()
        st.closeSettings()
        st.openWorkspace(projectId, workspaceId)
      }}
      className="text-text-dim hover:text-text hover:underline"
    >
      {title || workspaceId.slice(0, 8)}
    </button>
  )
}
