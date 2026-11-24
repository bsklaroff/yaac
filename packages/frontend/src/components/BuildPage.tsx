import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '#lib/api'
import { CloseIcon } from '#lib/icons'
import { buildDuration, IMAGE_KEY, isLive, logSteps, useFollowBuilds } from '#lib/images'
import { useUiStore } from '#lib/store'
import { relativeAge, useNow } from '#lib/time'
import { useSnapshotSelect } from '#lib/useSnapshot'
import type { ImageBuild, ImageBuildStatus } from '@yaac/shared/types'
import { YBadge, YButton, YDialog, YDialogClose, YDialogTitle, type YBadgeTone } from '#ui'

/** How often a running build's log is asked for what was added. */
const LOG_POLL_MS = 1_000

const STATUS_TONE: Record<ImageBuildStatus, YBadgeTone> = {
  queued: 'neutral', running: 'info', succeeded: 'success', failed: 'danger', cancelled: 'neutral',
}

export function BuildStatusBadge({ status }: { status: ImageBuildStatus }): JSX.Element {
  return <YBadge tone={STATUS_TONE[status]} dot>{status}</YBadge>
}

/**
 * A build's log, read by byte offset: each read asks for what was added
 * since the last, until the server says the log is done. A failed read is
 * tried again on the next tick while `live` says the build may still write.
 */
function useBuildLog(buildId: string, live: boolean): { text: string; error: string | null } {
  const [log, setLog] = useState({ text: '', error: null as string | null })
  const liveRef = useRef(live)
  liveRef.current = live
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let offset = 0
    let text = ''
    const read = async (): Promise<void> => {
      try {
        const next = await api.image.builds[':buildId'].log.$get({ param: { buildId }, query: { offset: String(offset) } })
        if (stopped) return
        text += next.text
        offset = next.offset
        setLog({ text, error: null })
        if (!next.done) timer = setTimeout(() => void read(), LOG_POLL_MS)
      } catch (err) {
        if (stopped) return
        setLog({ text, error: err instanceof Error ? err.message : String(err) })
        if (liveRef.current) timer = setTimeout(() => void read(), LOG_POLL_MS)
      }
    }
    void read()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [buildId])
  return log
}

/**
 * The build page (docs/image-builds.md "The queue"), over the app while the
 * URL's `?build=` names a build: what it built and from what, its check
 * warnings, its log as one collapsible section per BuildKit step, the hosts
 * the project's allowlist refused it, and Retry, Rebuild without cache and
 * Cancel.
 */
export function BuildPage(): JSX.Element {
  const buildId = useUiStore((s) => s.buildPageId)
  const openBuild = useUiStore((s) => s.openBuild)
  // Nothing is asked for until the snapshot says this server builds images.
  const driver = useSnapshotSelect((s) => s?.driver)
  const buildsImages = driver !== undefined && driver !== 'containerless'
  return (
    <YDialog open={buildId !== null && buildsImages} onOpenChange={(open) => { if (!open) openBuild(null) }} variant="sheet">
      {buildId !== null && <BuildBody key={buildId} buildId={buildId} />}
    </YDialog>
  )
}

function BuildBody({ buildId }: { buildId: string }): JSX.Element {
  useFollowBuilds()
  const queryClient = useQueryClient()
  const openBuild = useUiStore((s) => s.openBuild)
  const fetched = useQuery({
    queryKey: [IMAGE_KEY, 'build', buildId],
    queryFn: () => api.image.builds[':buildId'].$get({ param: { buildId } }),
    staleTime: 0,
  })
  // The snapshot carries a live build's progress as it changes.
  const live = useSnapshotSelect((s) => s?.imageBuilds.find((b) => b.id === buildId))
  const build = live ?? fetched.data
  // Until the build is known, its log may still be written.
  const log = useBuildLog(buildId, build === undefined ? !fetched.isError : isLive(build.status))
  const now = useNow(build !== undefined && isLive(build.status) ? 1_000 : 60_000)

  // A retry queues new builds of the same chain; follow this layer's.
  const follow = (b: ImageBuild, started: ImageBuild[]): void => {
    const next = started.find((s) => s.layer === b.layer) ?? started[0]
    if (next !== undefined) openBuild(next.id)
  }
  const act = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [IMAGE_KEY] }),
  })

  const header = (title: ReactNode, actions?: ReactNode): JSX.Element => (
    <div className="flex flex-wrap items-center gap-2 md:flex-nowrap">
      <YDialogTitle className="mr-auto min-w-0 truncate text-base font-semibold text-text">{title}</YDialogTitle>
      {actions}
      <YDialogClose render={<YButton variant="ghost" icon={CloseIcon} aria-label="Close build" title="Close build" />} />
    </div>
  )

  if (build === undefined) {
    return <>
      {header('Image build')}
      <p className="text-md text-subtle">{fetched.error ? fetched.error.message : 'Loading…'}</p>
    </>
  }

  const running = isLive(build.status)
  const steps = logSteps(log.text)
  const digests = Object.entries(build.baseDigests)
  const retry = (noCache: boolean): void => act.mutate(async () => {
    follow(build, await api.image.builds[':buildId'].retry.$post({ param: { buildId }, json: noCache ? { noCache } : {} }))
  })

  return (
    <>
      {header(`${build.imageName} · revision ${build.revisionNumber}`, running ? (
        <YButton
          variant="danger"
          onClick={() => act.mutate(() => api.image.builds[':buildId'].cancel.$post({ param: { buildId } }))}
          disabled={act.isPending}
        >
          Cancel
        </YButton>
      ) : <>
        <YButton onClick={() => retry(false)} disabled={act.isPending}>Retry</YButton>
        <YButton onClick={() => retry(true)} disabled={act.isPending}>Rebuild without cache</YButton>
      </>)}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 text-md">
          {act.error && <p className="text-danger">{act.error.message}</p>}

          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <Fact label="Status">
              <span className="flex flex-wrap items-center gap-2">
                <BuildStatusBadge status={build.status} />
                {running && build.stepText && <span className="truncate font-mono text-sm text-muted">{build.stepText}</span>}
              </span>
            </Fact>
            {build.error && <Fact label="Error"><span className="whitespace-pre-wrap text-danger">{build.error}</span></Fact>}
            <Fact label="Trigger">{build.reason}{build.noCache ? ', without cache' : ''}</Fact>
            <Fact label="Layer">{build.layer}</Fact>
            <Fact label="Queued">{relativeAge(build.queuedAt)}</Fact>
            {build.startedAt && <Fact label="Duration">{buildDuration(build, now)}</Fact>}
            <Fact label="Cache hits">{build.cachedSteps} of {build.totalSteps} steps</Fact>
            <Fact label="Tag"><code className="break-all">{build.tag}</code></Fact>
            {build.parentTag && <Fact label="Parent"><code className="break-all">{build.parentTag}</code></Fact>}
            {digests.length > 0 && (
              <Fact label="Base images">
                {digests.map(([ref, digest]) => (
                  <div key={ref} className="break-all font-mono text-sm">{ref} <span className="text-subtle">{digest}</span></div>
                ))}
              </Fact>
            )}
            {build.buildkitVersion && <Fact label="BuildKit">{build.buildkitVersion}</Fact>}
          </dl>

          {build.warnings.length > 0 && (
            <section aria-label="Check warnings" className="flex flex-col gap-1">
              <h3 className="font-medium">Check warnings</h3>
              {build.warnings.map((w, i) => (
                <p key={i} className="text-warning">{w.line !== undefined ? `Line ${w.line}: ` : ''}{w.message}</p>
              ))}
            </section>
          )}

          {build.blockedHosts.length > 0 && (
            <section aria-label="Blocked hosts" className="flex flex-col gap-1">
              <h3 className="font-medium">Blocked hosts</h3>
              <p className="text-sm text-subtle">
                The build tried these and the project&apos;s allowlist refused them. Allowing one builds again.
              </p>
              {build.blockedHosts.map((host) => (
                <div key={host} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate">{host}</code>
                  <YButton
                    size="sm"
                    disabled={act.isPending}
                    onClick={() => act.mutate(async () => {
                      const { builds } = await api.image.builds[':buildId']['allow-host'].$post({ param: { buildId }, json: { host } })
                      follow(build, builds)
                    })}
                  >
                    Allow for this project
                  </YButton>
                </div>
              ))}
            </section>
          )}

          <section aria-label="Log" className="flex flex-col gap-1">
            <h3 className="font-medium">Log</h3>
            {log.error && <p className="text-danger">{log.error}</p>}
            {steps.length === 0 && <p className="text-subtle">{running ? 'Waiting for build output…' : 'No output.'}</p>}
            {steps.map((step, i) => (
              <details
                key={step.id}
                open={step.outcome === 'error' || (running && i === steps.length - 1)}
                className="rounded-sm bg-sunken/80"
              >
                <summary className="flex cursor-pointer items-center gap-2 px-2 py-1 font-mono text-sm">
                  <span className="min-w-0 flex-1 truncate">{step.id !== '' && <span className="text-subtle">#{step.id} </span>}{step.title}</span>
                  {step.outcome === 'cached' && <YBadge>cached</YBadge>}
                  {step.outcome === 'error' && <YBadge tone="danger">error</YBadge>}
                  {step.took && <span className="text-xs text-subtle">{step.took}</span>}
                </summary>
                {step.lines.length > 0 && (
                  <pre className="whitespace-pre-wrap break-words px-2 pb-2 font-mono text-xs leading-relaxed text-muted">
                    {step.lines.join('\n')}
                  </pre>
                )}
              </details>
            ))}
          </section>
        </div>
      </div>
    </>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return <>
    <dt className="text-subtle">{label}</dt>
    <dd className="min-w-0">{children}</dd>
  </>
}
