import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation } from '@tanstack/react-query'
import { Popover } from '@base-ui/react/popover'
import { PopoverPopup } from '#components/ui/menu'
import { WarningIcon } from '#lib/icons'
import { api } from '#lib/api'
import { restartWorkspace } from '#lib/createWorkspace'
import { useProvisionWorkspace } from '#lib/useProvisionWorkspace'
import { useTeammateView } from '#lib/viewer'
import { useSnapshot } from '#lib/useSnapshot'
import type { ProjectSummary, ScratchDirSettings, WorkspaceListEntry } from '@yaac/shared/types'

/**
 * Workspace-bar warning that some of the project's scratch dirs are
 * tracked in git (docs/project-config.md "Scratch directories"): a stop
 * empties them, committed files included, which then show as deleted after
 * a restart; under k8s they already do while it runs, hidden by its volume.
 * The popover offers to keep those paths in the checkout and restart the
 * workspace, or to stop warning about them in this project. Paths the
 * project already ignores are not shown.
 */
export function TrackedScratchDirsBadge({ workspace, project, className }: {
  workspace: WorkspaceListEntry
  project: ProjectSummary
  /** Positioning and the context-appropriate hover highlight for the trigger. */
  className?: string
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const readOnly = useTeammateView()
  const provision = useProvisionWorkspace()
  const containerless = useSnapshot()?.driver === 'containerless'
  const { ignoredTracked } = project.scratchDirs
  const paths = (workspace.trackedScratchDirs ?? []).filter((p) => !ignoredTracked.includes(p))
  const update = useMutation({
    mutationFn: (json: Partial<ScratchDirSettings>) =>
      api.project[':projectId']['scratch-dirs'].$put({ param: { projectId: project.id }, json }),
  })
  const keep = useMutation({
    mutationFn: () => api.workspace[':id']['keep-scratch-dirs'].$post({ param: { id: workspace.workspaceId }, json: { paths } }),
  })
  const pending = update.isPending || keep.isPending
  const error = update.error ?? keep.error
  if (paths.length === 0) return null

  const keepInCheckout = (): void => {
    keep.mutate(undefined, {
      onSuccess: () => {
        setOpen(false)
        provision({
          workspaceId: workspace.workspaceId,
          projectId: workspace.projectId,
          ...(workspace.sessions[0] !== undefined ? { tool: workspace.sessions[0].tool } : {}),
          kind: 'restart',
          ...(workspace.groupId !== undefined ? { groupId: workspace.groupId } : {}),
        }, (onProgress) => restartWorkspace(workspace.workspaceId, onProgress))
      },
    })
  }
  const ignore = (): void => {
    update.mutate({ ignoredTracked: [...ignoredTracked, ...paths] })
  }
  const listed = paths.map((p) => `${p}/`).join(', ')
  const one = paths.length === 1

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label="Scratch directories tracked in git"
        className={clsx(
          'flex shrink-0 items-center gap-1 rounded bg-warning/15 px-1 py-0.5 text-xs font-medium text-warning transition',
          className,
        )}
      >
        <WarningIcon size={12} />
        {paths.length === 1 ? paths[0] : `${paths.length} dirs`}
      </Popover.Trigger>
      <PopoverPopup side="bottom" align="end" sideOffset={4} className="max-w-xs">
        <div className="px-2 pb-0.5 pt-1 text-[11px] font-medium text-warning">Tracked in git</div>
        <p className="px-2 pb-1.5 text-xs leading-relaxed text-text-dim">
          <code className="font-mono text-text">{listed}</code>{' '}
          {one ? 'is' : 'are'} tracked in git, but this project makes {one ? 'it a scratch dir' : 'them scratch dirs'},
          so {one ? 'its' : 'their'} contents aren&apos;t kept for a restart: a stop deletes them, committed files
          included. Those stay in git history, and <code className="font-mono text-text">git checkout</code> brings
          them back.
          {!containerless && ' While the workspace runs, its volume hides the committed files, so they show as deleted here.'}
          {' '}Committing such a deletion removes them from the branch.
        </p>
        {!readOnly && (
          <div className="flex flex-col gap-1.5 p-1">
            <button
              type="button"
              disabled={pending}
              onClick={keepInCheckout}
              className="w-full rounded-md border border-border-strong bg-surface-3 px-2 py-1.5 text-xs font-medium
                text-text transition hover:bg-border-strong disabled:opacity-50"
            >
              Keep in the checkout and restart
            </button>
            <label className="flex items-center gap-1.5 px-1 text-[11px] text-text-dim">
              <input type="checkbox" checked={false} disabled={pending} onChange={ignore} />
              Don&apos;t show again for this project
            </label>
            {error && <p className="px-1 text-xs text-red-400">{error.message}</p>}
          </div>
        )}
      </PopoverPopup>
    </Popover.Root>
  )
}
