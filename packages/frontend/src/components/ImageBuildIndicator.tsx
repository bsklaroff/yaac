import { useState, type JSX } from 'react'
import { CheckIcon, LoadingIcon, WarningIcon } from '#lib/icons'
import { ImageBuildsOverlay } from '#components/ImageBuildsOverlay'
import { useSnapshot } from '#lib/useSnapshot'

/**
 * Sidebar-header pill shown while the server builds or pushes container images
 * (worktree create or the background prewarm sweep), when a build failed, or
 * when finished builds remain in the history. Clicking opens the
 * fullscreen overlay with per-build status and the live podman log tail.
 * Finished rows persist until dismissed, so the pill stays (in a muted
 * "done" state) as an entry point to review or clear them; it hides only once
 * there is nothing left in scope.
 *
 * Scoped to the active project: only builds that project requested (its
 * chain layers, joined shared layers), plus project-less shared
 * infrastructure builds (the proxy sidecar), which always show. A build for
 * a different project stays hidden until you switch to it.
 */
export function ImageBuildIndicator({ projectSlug }: { projectSlug: string | null }): JSX.Element | null {
  const allBuilds = useSnapshot()?.imageBuilds ?? []
  const [open, setOpen] = useState(false)

  const builds = allBuilds.filter(
    (b) => b.projectSlugs.length === 0 || (projectSlug !== null && b.projectSlugs.includes(projectSlug)),
  )
  const running = builds.filter((b) => b.status === 'running').length
  const failed = builds.filter((b) => b.status === 'failed').length
  // Keep the overlay mounted while open so a build finishing under the user
  // doesn't yank the dialog away. Otherwise the pill hides only when nothing
  // is left in scope — persisted succeeded rows keep it (muted) so they stay
  // reachable and dismissable.
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
          className="flex shrink-0 items-center gap-1 rounded bg-[#d65858]/15 px-1 py-0.5 text-xs font-medium
            text-[#d65858] transition hover:bg-[#d65858]/25"
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
