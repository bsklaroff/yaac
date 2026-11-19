import { useState, type JSX } from 'react'
import { CheckIcon, LoadingIcon, WarningIcon } from '#lib/icons'
import { ImageBuildsOverlay } from '#components/ImageBuildsOverlay'
import { useSnapshot } from '#lib/useSnapshot'
import { YButton } from '#ui'

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
        <YButton variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label="Show image build progress">
          <LoadingIcon size={11} className="animate-spin" />
          building{running > 1 ? ` ${running}` : ''}
        </YButton>
      ) : failed > 0 ? (
        <YButton variant="danger" size="sm" onClick={() => setOpen(true)} aria-label="Show failed image builds">
          <WarningIcon size={11} />
          build failed
        </YButton>
      ) : builds.length > 0 ? (
        <YButton variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label="Show image build history">
          <CheckIcon size={11} className="text-success/70" />
          builds{builds.length > 1 ? ` ${builds.length}` : ''}
        </YButton>
      ) : null}
      <ImageBuildsOverlay open={open} onOpenChange={setOpen} builds={builds} />
    </>
  )
}
