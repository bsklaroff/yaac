import { useEffect, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import { Dialog } from '@base-ui/react/dialog'
import { CheckIcon, CloseIcon, LoadingIcon, WarningIcon } from '#lib/icons'
import { dismissImageBuild, getImageBuildLog } from '#lib/imageBuildsApi'
import type { ImageBuildEntry } from '@yaac/shared/types'

/** Human relative age from the entry's UTC 'YYYY-MM-DD HH:MM:SS' time. */
function relativeAge(startedAt: string): string {
  const t = Date.parse(startedAt.replace(' ', 'T') + 'Z')
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** `yaac-base:abc123def456…` → `yaac-base:abc123` — enough to tell tags apart. */
function shortTag(tag: string): string {
  const idx = tag.lastIndexOf(':')
  if (idx < 0) return tag
  return `${tag.slice(0, idx)}:${tag.slice(idx + 1, idx + 7)}`
}

function StatusIcon({ status }: { status: ImageBuildEntry['status'] }): JSX.Element {
  if (status === 'running') return <LoadingIcon size={12} className="shrink-0 animate-spin text-text-dim" />
  if (status === 'failed') return <WarningIcon size={12} className="shrink-0 text-[#d65858]" />
  return <CheckIcon size={12} className="shrink-0 text-emerald-400" />
}

/**
 * Fullscreen overlay listing every tracked image build/push with a live,
 * auto-scrolling podman log tail for the selected one. Metadata (status,
 * step N/M) arrives through the snapshot; the log is polled from
 * `/image/builds/:id/log` every 1.5s while the selected build runs, plus
 * one fetch when it settles so the tail is complete.
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

  // Follow the user's pick while it exists; otherwise the newest running
  // entry (builds arrive newest-first), falling back to the newest overall.
  const selected = builds.find((b) => b.id === selectedId)
    ?? builds.find((b) => b.status === 'running')
    ?? builds[0]

  const [log, setLog] = useState('')
  const selectedRunning = selected?.status === 'running'
  const logId = open ? selected?.id : undefined
  useEffect(() => {
    if (!logId) return
    setLog('')
    let cancelled = false
    const fetchLog = (): void => {
      getImageBuildLog(logId)
        .then((r) => { if (!cancelled) setLog(r.log) })
        .catch(() => { /* entry aged out mid-poll; selection falls back */ })
    }
    fetchLog()
    if (!selectedRunning) return () => { cancelled = true }
    const t = setInterval(fetchLog, 1500)
    return () => { cancelled = true; clearInterval(t) }
  }, [logId, selectedRunning])

  const boxRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-4 flex flex-col gap-2 rounded-xl border border-white/[0.06]
          bg-surface p-4 text-text shadow-[0_16px_48px_rgba(0,0,0,0.5)] outline-none transition duration-150
          data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95
          data-[ending-style]:opacity-0">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-xs font-semibold text-text-dim">Image builds</Dialog.Title>
            <Dialog.Close
              title="Close"
              aria-label="Close"
              className="flex h-6 w-6 items-center justify-center rounded text-text-faint transition
                hover:bg-surface-2 hover:text-text"
            >
              <CloseIcon size={14} />
            </Dialog.Close>
          </div>

          {builds.length === 0 && (
            <p className="text-xs text-text-faint">No image builds yet.</p>
          )}

          {builds.length > 0 && (
            <div className="flex min-h-0 flex-1 gap-3">
              <ul className="w-80 shrink-0 overflow-y-auto">
                {builds.map((b) => (
                  <li key={b.id} className="relative">
                    <button
                      type="button"
                      onClick={() => setSelectedId(b.id)}
                      className={clsx(
                        'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition',
                        selected?.id === b.id ? 'bg-surface-2' : 'hover:bg-surface-2/50',
                      )}
                    >
                      <span className="flex items-center gap-1.5 text-xs">
                        <StatusIcon status={b.status} />
                        <span className="font-medium">
                          {b.action === 'push' ? 'push' : `${b.layer} layer`}
                        </span>
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
                        <span className="truncate text-[10px] text-[#d65858]">{b.error}</span>
                      )}
                    </button>
                    {b.status !== 'running' && (
                      <button
                        type="button"
                        onClick={() => { void dismissImageBuild(b.id).catch(() => {}) }}
                        title="Dismiss (a failed chain retries on the next background pass)"
                        aria-label="Dismiss build entry"
                        className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded
                          text-text-faint transition hover:bg-surface-3 hover:text-text"
                      >
                        <CloseIcon size={11} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <pre
                ref={boxRef}
                className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded bg-bg/80 p-2
                  font-mono text-[10px] leading-relaxed text-text-dim"
              >
                {log || (selectedRunning ? 'Waiting for build output…' : '')}
              </pre>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
