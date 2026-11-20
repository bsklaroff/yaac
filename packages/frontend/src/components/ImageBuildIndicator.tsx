import { useState, type JSX } from 'react'
import { CheckIcon, LoadingIcon, WarningIcon } from '#lib/icons'
import { ImageBuildsOverlay } from '#components/ImageBuildsOverlay'
import { useSnapshotSelect } from '#lib/useSnapshot'
import { YButton } from '#ui'

/** Shrinks with a short row, never below a square around its icon. */
const SHRINK = 'min-w-6 shrink'

/**
 * Sidebar status-strip chit for image builds: running, failed, or finished
 * ones not yet dismissed (shown muted). Clicking opens `ImageBuildsOverlay`.
 * Shows the builds of the given projects, one chit for all of them. Its
 * label truncates in a row short of room, leaving the icon.
 */
export function ImageBuildIndicator({ projectIds }: { projectIds: string[] }): JSX.Element | null {
  const allBuilds = useSnapshotSelect((s) => s?.imageBuilds) ?? []
  const [open, setOpen] = useState(false)

  const builds = allBuilds.filter((b) => b.projectIds.some((id) => projectIds.includes(id)))
  const running = builds.filter((b) => b.status === 'running').length
  const failed = builds.filter((b) => b.status === 'failed').length
  // Stay mounted while the overlay is open, even if the list empties.
  if (builds.length === 0 && !open) return null

  return (
    <>
      {running > 0 ? (
        <YButton variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label="Show image build progress" title="Show image build progress" className={SHRINK}>
          <LoadingIcon size={11} className="shrink-0 animate-spin" />
          <span className="truncate">building{running > 1 ? ` ${running}` : ''}</span>
        </YButton>
      ) : failed > 0 ? (
        <YButton variant="danger" size="sm" onClick={() => setOpen(true)} aria-label="Show failed image builds" title="Show failed image builds" className={SHRINK}>
          <WarningIcon size={11} className="shrink-0" />
          <span className="truncate">build failed</span>
        </YButton>
      ) : builds.length > 0 ? (
        <YButton variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label="Show image build history" title="Show image build history" className={SHRINK}>
          <CheckIcon size={11} className="shrink-0 text-success/70" />
          <span className="truncate">builds{builds.length > 1 ? ` ${builds.length}` : ''}</span>
        </YButton>
      ) : null}
      <ImageBuildsOverlay open={open} onOpenChange={setOpen} builds={builds} />
    </>
  )
}
