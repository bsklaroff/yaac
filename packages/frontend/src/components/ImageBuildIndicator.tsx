import { useState, type JSX } from 'react'
import { CheckIcon, LoadingIcon, WarningIcon } from '#lib/icons'
import { ImageBuildsOverlay } from '#components/ImageBuildsOverlay'
import { useSnapshot } from '#lib/useSnapshot'

/**
 * Sidebar-header pill for image builds: running, failed, or finished ones not
 * yet dismissed (shown muted). Clicking opens `ImageBuildsOverlay`. Shows the
 * active project's builds.
 */
export function ImageBuildIndicator({ projectId }: { projectId: string | null }): JSX.Element | null {
  const allBuilds = useSnapshot()?.imageBuilds ?? []
  const [open, setOpen] = useState(false)

  const builds = allBuilds.filter((b) => projectId !== null && b.projectIds.includes(projectId))
  const running = builds.filter((b) => b.status === 'running').length
  const failed = builds.filter((b) => b.status === 'failed').length
  // Stay mounted while the overlay is open, even if the list empties.
  if (builds.length === 0 && !open) return null

  return (
    <>
      {running > 0 ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Show image build progress"
          className="flex shrink-0 items-center gap-1 rounded bg-surface-2 px-1 py-0.5 text-xs font-medium
            text-text-dim transition hover:bg-surface-3 hover:text-text"
        >
          <LoadingIcon size={11} className="animate-spin" />
          building{running > 1 ? ` ${running}` : ''}
        </button>
      ) : failed > 0 ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Show failed image builds"
          className="flex shrink-0 items-center gap-1 rounded bg-danger/15 px-1 py-0.5 text-xs font-medium
            text-danger transition hover:bg-danger/25"
        >
          <WarningIcon size={11} />
          build failed
        </button>
      ) : builds.length > 0 ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Show image build history"
          className="flex shrink-0 items-center gap-1 rounded bg-surface-2 px-1 py-0.5 text-xs font-medium
            text-text-faint transition hover:bg-surface-3 hover:text-text-dim"
        >
          <CheckIcon size={11} className="text-emerald-400/70" />
          builds{builds.length > 1 ? ` ${builds.length}` : ''}
        </button>
      ) : null}
      <ImageBuildsOverlay open={open} onOpenChange={setOpen} builds={builds} />
    </>
  )
}
