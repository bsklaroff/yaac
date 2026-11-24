import type { JSX } from 'react'
import { LoadingIcon, WarningIcon } from '#lib/icons'
import { isLive } from '#lib/images'
import { useUiStore } from '#lib/store'
import { useSnapshotSelect } from '#lib/useSnapshot'
import { YButton } from '#ui'

/** Shrinks with a short row, never below a square around its icon. */
const SHRINK = 'min-w-6 shrink'

/**
 * Sidebar status-strip chit for image builds, from the snapshot's live list:
 * builds queued or running, else recent failures. Clicking opens the page of
 * the newest one it counts. Shows the builds of the given projects, one chit
 * for all of them. Its label truncates in a row short of room, leaving the
 * icon.
 */
export function ImageBuildIndicator({ projectIds }: { projectIds: string[] }): JSX.Element | null {
  const allBuilds = useSnapshotSelect((s) => s?.imageBuilds) ?? []
  const openBuild = useUiStore((s) => s.openBuild)

  const builds = allBuilds
    .filter((b) => projectIds.includes(b.projectId))
    .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
  const live = builds.filter((b) => isLive(b.status))
  const failed = builds.filter((b) => b.status === 'failed')

  if (live.length > 0) {
    return (
      <YButton variant="ghost" size="sm" onClick={() => openBuild(live[0].id)} aria-label="Show image build progress" title="Show image build progress" className={SHRINK}>
        <LoadingIcon size={11} className="shrink-0 animate-spin" />
        <span className="truncate">building{live.length > 1 ? ` ${live.length}` : ''}</span>
      </YButton>
    )
  }
  if (failed.length > 0) {
    return (
      <YButton variant="danger" size="sm" onClick={() => openBuild(failed[0].id)} aria-label="Show failed image build" title="Show failed image build" className={SHRINK}>
        <WarningIcon size={11} className="shrink-0" />
        <span className="truncate">build failed</span>
      </YButton>
    )
  }
  return null
}
