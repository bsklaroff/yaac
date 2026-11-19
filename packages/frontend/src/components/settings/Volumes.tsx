import { useState, type FormEvent, type JSX } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '#lib/api'
import { DeleteIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'
import { relativeAge } from '#lib/time'
import { useVolumes, volumesKey } from '#lib/volumes'
import type { VolumeEntry } from '@yaac/shared/types'
import { YButton, YConfirm, YInput, YSettingRow } from '#ui'

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
    <YSettingRow
      stacked
      label="Volumes"
      hint={<>
        Named storage that outlives any one workspace, for data an app keeps between runs. One
        running workspace at a time attaches a volume, picked when it is created, and sees it at{' '}
        <code className="text-muted">$YAAC_VOLUME_DIR</code>. A stopped workspace attaches its
        volume again when restarted. The size is enforced only where the cluster gives each volume
        its own disk.
      </>}
    >
      {volumes !== undefined && (
        <div className="divide-y divide-line">
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
          {volumes.length === 0 && <p className="text-md text-subtle">No volumes yet.</p>}
        </div>
      )}

      {!readOnly && (
        <form onSubmit={submit} className="mt-2 flex gap-2">
          <YInput
            aria-label="Volume name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name (a-z, 0-9, -)"
            maxLength={40}
            className="flex-1 font-mono"
          />
          <YInput
            aria-label="Volume size"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            placeholder="10Gi"
            className="w-20 font-mono"
          />
          <YButton type="submit" disabled={create.isPending || name.trim() === ''}>
            {create.isPending ? 'Creating…' : 'Create'}
          </YButton>
        </form>
      )}
      {error && <p className="mt-2 text-md text-danger">{error.message}</p>}

      <YConfirm
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) setDeleting(null) }}
        title={`Delete volume “${deleting ?? ''}”?`}
        description="Its data is deleted for good. Stopped workspaces that had it restart without it."
        busy={remove.isPending}
        error={remove.error?.message}
        onConfirm={() => { if (deleting !== null) remove.mutate(deleting) }}
      />
    </YSettingRow>
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
    <div data-volume={volume.name} className="py-1.5 text-md">
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate font-mono text-text">{volume.name}</span>
        {resizing === null ? (
          <span className="shrink-0 font-mono text-sm text-subtle">{volume.size}</span>
        ) : (
          <YInput
            autoFocus
            aria-label={`New size of ${volume.name}`}
            value={resizing}
            onChange={(e) => onResizing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onResize()
              if (e.key === 'Escape') onResizing(null)
            }}
            className="h-6 w-20 font-mono"
          />
        )}
        {!readOnly && (resizing === null ? (
          <YButton variant="secondary" size="sm" onClick={() => onResizing(volume.size)}>Resize</YButton>
        ) : (
          <>
            <YButton variant="ghost" size="sm" onClick={onResize} disabled={resizePending}>Save</YButton>
            <YButton variant="ghost" size="sm" onClick={() => onResizing(null)}>Cancel</YButton>
          </>
        ))}
        {!readOnly && (
          <YButton
            variant="ghost"
            size="sm"
            icon={DeleteIcon}
            onClick={onDelete}
            aria-label={`Delete volume ${volume.name}`}
          />
        )}
      </div>
      <div className="mt-0.5 text-sm text-subtle">
        {holder !== undefined ? (
          <>
            Attached to running <WorkspaceLink projectId={projectId} {...holder} />{' '}
            <span title={new Date(holder.attachedAt).toLocaleString()}>{relativeAge(holder.attachedAt)}</span>
          </>
        ) : 'Free'}
        {stoppedWorkspaces.length > 0 && (
          <>
            {'. Restarts with it: '}
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
    <YButton
      variant="link"
      onClick={() => {
        const st = useUiStore.getState()
        st.closeSettings()
        st.openWorkspace(projectId, workspaceId)
      }}
    >
      {title || workspaceId.slice(0, 8)}
    </YButton>
  )
}
