import { useEffect, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CheckIcon, CloseIcon, LoadingIcon, RestartIcon, WarningIcon } from '#lib/icons'
import { MasterDetail } from '#components/ui/MasterDetail'
import { Modal } from '#components/ui/Modal'
import { api } from '#lib/api'
import { useIsMobile } from '#lib/viewport'
import type { ImageBuildEntry } from '@yaac/shared/types'
import { relativeAge } from '#lib/time'

/** `yaac-base:abc123def456…` → `yaac-base:abc123`. */
function shortTag(tag: string): string {
  const idx = tag.lastIndexOf(':')
  if (idx < 0) return tag
  return `${tag.slice(0, idx)}:${tag.slice(idx + 1, idx + 7)}`
}

/** Row label: the layer name, "push", or the shared proxy sidecar. */
function buildLabel(b: ImageBuildEntry): string {
  if (b.action === 'push') return 'push'
  if (b.layer === 'proxy') return 'proxy sidecar'
  return `${b.layer} layer`
}

function StatusIcon({ status }: { status: ImageBuildEntry['status'] }): JSX.Element {
  if (status === 'running') return <LoadingIcon size={12} className="shrink-0 animate-spin text-text-dim" />
  if (status === 'failed') return <WarningIcon size={12} className="shrink-0 text-danger" />
  return <CheckIcon size={12} className="shrink-0 text-emerald-400" />
}

/**
 * Fullscreen overlay listing image builds and pushes, with an auto-scrolling
 * log for the selected one. Status comes from the snapshot; the podman log
 * tail does not, so it is fetched here.
 */
export function ImageBuildsOverlay({
  open,
  onOpenChange,
  builds,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  builds: ImageBuildEntry[]
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const isMobile = useIsMobile()

  // The user's pick, else (desktop only) the newest running build, else the
  // newest. On mobile the list and log are separate screens, so nothing is
  // selected (or polled) until a tap.
  const picked = builds.find((b) => b.id === selectedId)
  const selected = picked
    ?? (isMobile ? undefined : builds.find((b) => b.status === 'running') ?? builds[0])

  // The overlay stays mounted while closed; clear the pick so mobile
  // reopens on the list.
  useEffect(() => { if (!open) setSelectedId(null) }, [open])

  // Re-fetched every 1.5s while the build runs. Once it finishes the key's
  // status changes, so the final log is fetched once more.
  const selectedRunning = selected?.status === 'running'
  const { data: log = '' } = useQuery({
    queryKey: ['image-build-log', selected?.id, selected?.status],
    queryFn: async () => (await api.image.builds[':id'].log.$get({ param: { id: selected?.id ?? '' } })).log,
    enabled: open && selected !== undefined,
    staleTime: 0,
    refetchInterval: selectedRunning ? 1500 : false,
    // Keep the log on screen while the finished build's final log loads.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === selected?.id ? prev : undefined),
  })

  // Retry and dismiss change the snapshot's build list, so their result
  // shows there; only a failure needs showing here.
  const act = useMutation({ mutationFn: (run: () => Promise<unknown>) => run() })

  const boxRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  return (
    <Modal open={open} onOpenChange={onOpenChange} variant="sheet" title="Image builds">
      {act.error && <p className="text-xs text-danger">{act.error.message}</p>}

      {builds.length === 0 && (
        <p className="text-xs text-text-faint">No image builds yet.</p>
      )}

      {builds.length > 0 && (
        <MasterDetail
          detailOpen={isMobile && picked !== undefined}
          onBack={() => setSelectedId(null)}
          backLabel="Back to builds"
          master={
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {builds.map((b) => (
                <li key={b.id} className="relative">
                  <button
                    type="button"
                    onClick={() => setSelectedId(b.id)}
                    className={clsx(
                      'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition',
                      // Leave room for the always-visible action buttons.
                      b.status !== 'running' && 'max-md:pr-16',
                      'max-md:py-2.5',
                      selected?.id === b.id ? 'bg-surface-2' : 'hover:bg-surface-2/50',
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-xs">
                      <StatusIcon status={b.status} />
                      <span className="font-medium">{buildLabel(b)}</span>
                      <span className="truncate font-mono text-text-faint">{shortTag(b.tag)}</span>
                    </span>
                    <span className="truncate text-[11px] text-text-dim">
                      {b.projectSlugs.join(', ')} · {b.reason} · {relativeAge(b.startedAt)}
                      {b.stepCurrent !== undefined && b.stepTotal !== undefined && (
                        <> · step {b.stepCurrent}/{b.stepTotal}</>
                      )}
                    </span>
                    {b.status === 'running' && b.stepText && (
                      <span className="truncate font-mono text-[10px] text-text-faint">{b.stepText}</span>
                    )}
                    {b.status === 'failed' && b.error && (
                      <span className="truncate text-[10px] text-danger">{b.error}</span>
                    )}
                  </button>
                  {b.status !== 'running' && (
                    <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5">
                      {b.status === 'failed' && (
                        <button
                          type="button"
                          onClick={() => act.mutate(() => api.image.builds[':id'].retry.$post({ param: { id: b.id } }))}
                          title="Retry build"
                          aria-label="Retry build"
                          className="flex h-5 w-5 items-center justify-center rounded
                            text-text-faint transition hover:bg-surface-3 hover:text-text
                            max-md:h-7 max-md:w-7"
                        >
                          <RestartIcon size={11} />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => act.mutate(() => api.image.builds[':id'].$delete({ param: { id: b.id } }))}
                        title="Dismiss (hides this row; does not rebuild)"
                        aria-label="Dismiss build entry"
                        className="flex h-5 w-5 items-center justify-center rounded
                          text-text-faint transition hover:bg-surface-3 hover:text-text
                          max-md:h-7 max-md:w-7"
                      >
                        <CloseIcon size={11} />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          }
          detail={
            <pre
              ref={boxRef}
              className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded bg-bg/80 p-2
                font-mono text-[10px] leading-relaxed text-text-dim"
            >
              {log || (selectedRunning ? 'Waiting for build output…' : '')}
            </pre>
          }
        />
      )}
    </Modal>
  )
}
