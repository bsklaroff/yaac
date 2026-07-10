import { useState, type JSX } from 'react'
import { LoadingIcon, WarningIcon } from '#lib/icons'
import { ImageBuildsOverlay } from '#components/ImageBuildsOverlay'
import { useSnapshot } from '#lib/useSnapshot'

/**
 * Sidebar-header pill shown while the server builds or pushes container
 * images (session create, background prewarm, or a project rebuild), or
 * when a build failed and awaits dismissal. Clicking opens the fullscreen
 * overlay with per-build status and the live podman log tail. Hidden when
 * there is nothing running or failed.
 */
export function ImageBuildIndicator(): JSX.Element | null {
  const builds = useSnapshot()?.imageBuilds ?? []
  const [open, setOpen] = useState(false)

  const running = builds.filter((b) => b.status === 'running').length
  const failed = builds.filter((b) => b.status === 'failed').length
  // Keep the overlay mounted while open so a build finishing under the
  // user doesn't yank the dialog away with the pill.
  if (running === 0 && failed === 0 && !open) return null

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
      ) : null}
      <ImageBuildsOverlay open={open} onOpenChange={setOpen} builds={builds} />
    </>
  )
}
