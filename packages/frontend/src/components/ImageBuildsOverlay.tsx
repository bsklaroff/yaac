import { useEffect, useRef, useState, type JSX } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CheckIcon, CloseIcon, LoadingIcon, RestartIcon, WarningIcon } from '#lib/icons'
import { MasterDetail } from '#components/MasterDetail'
import { api } from '#lib/api'
import { useIsMobile } from '#lib/viewport'
import { useProjectName } from '#lib/projectIdentity'
import { useSnapshot } from '#lib/useSnapshot'
import { projectsOf, useWhoami } from '#lib/viewer'
import type { ImageBuildEntry } from '@yaac/shared/types'
import { relativeAge } from '#lib/time'
import { YButton, YDialog, YRowFrame } from '#ui'

/** `yaac-base:abc123def456…` → `yaac-base:abc123`. */
function shortTag(tag: string): string {
  const idx = tag.lastIndexOf(':')
  if (idx < 0) return tag
  return `${tag.slice(0, idx)}:${tag.slice(idx + 1, idx + 7)}`
}

function StatusIcon({ status }: { status: ImageBuildEntry['status'] }): JSX.Element {
  if (status === 'running') return <LoadingIcon size={12} className="shrink-0 animate-spin text-muted" />
  if (status === 'failed') return <WarningIcon size={12} className="shrink-0 text-danger" />
  return <CheckIcon size={12} className="shrink-0 text-success" />
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
  const projectName = useProjectName()
  // A project chain's build is its owner's to retry or dismiss; a shared
  // image's (base, tools) is anyone's.
  const me = useWhoami()?.userId
  const mine = new Set(projectsOf(useSnapshot()?.projects ?? [], me).map((p) => p.id))
  const canAct = (b: ImageBuildEntry): boolean =>
    (b.layer !== 'project' && b.layer !== 'user') || b.projectIds.some((id) => mine.has(id))

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
    <YDialog open={open} onOpenChange={onOpenChange} variant="sheet" title="Image builds">
      {act.error && <p className="text-md text-danger">{act.error.message}</p>}

      {builds.length === 0 && (
        <p className="text-md text-subtle">No image builds yet.</p>
      )}

      {builds.length > 0 && (
        <MasterDetail
          detailOpen={isMobile && picked !== undefined}
          onBack={() => setSelectedId(null)}
          backLabel="Back to builds"
          master={
            <div className="min-h-0 flex-1 overflow-y-auto">
              {builds.map((b) => (
                <YRowFrame
                  key={b.id}
                  label={`${b.layer} layer ${shortTag(b.tag)}`}
                  onSelect={() => setSelectedId(b.id)}
                  selected={selected?.id === b.id}
                  actionsShown
                  className="items-start py-1.5 pl-2 pr-1.5 max-md:py-2.5"
                  actions={b.status !== 'running' && canAct(b) && (
                    <>
                      {b.status === 'failed' && (
                        <YButton
                          variant="ghost"
                          size="sm"
                          icon={RestartIcon}
                          onClick={() => act.mutate(() => api.image.builds[':id'].retry.$post({ param: { id: b.id } }))}
                          title="Retry build"
                          aria-label="Retry build"
                          className="max-md:size-7"
                        />
                      )}
                      <YButton
                        variant="ghost"
                        size="sm"
                        icon={CloseIcon}
                        onClick={() => act.mutate(() => api.image.builds[':id'].$delete({ param: { id: b.id } }))}
                        title="Dismiss (hides this row; does not rebuild)"
                        aria-label="Dismiss build entry"
                        className="max-md:size-7"
                      />
                    </>
                  )}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5 text-md">
                      <StatusIcon status={b.status} />
                      <span className="font-medium">{b.layer} layer</span>
                      <span className="truncate font-mono text-subtle">{shortTag(b.tag)}</span>
                    </span>
                    <span className="flex min-w-0 items-center gap-2 text-sm text-muted">
                      <span className="truncate">{b.projectIds.map(projectName).join(', ')}</span>
                      <span className="shrink-0">{b.reason}</span>
                      <span className="shrink-0">{relativeAge(b.startedAt)}</span>
                      {b.stepCurrent !== undefined && b.stepTotal !== undefined && (
                        <span className="shrink-0">step {b.stepCurrent}/{b.stepTotal}</span>
                      )}
                    </span>
                    {b.status === 'running' && b.stepText && (
                      <span className="truncate font-mono text-xs text-subtle">{b.stepText}</span>
                    )}
                    {b.status === 'failed' && b.error && (
                      <span className="truncate text-xs text-danger">{b.error}</span>
                    )}
                  </div>
                </YRowFrame>
              ))}
            </div>
          }
          detail={
            <pre
              ref={boxRef}
              className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded bg-sunken/80 p-2
                font-mono text-xs leading-relaxed text-muted"
            >
              {log || (selectedRunning ? 'Waiting for build output…' : '')}
            </pre>
          }
        />
      )}
    </YDialog>
  )
}
