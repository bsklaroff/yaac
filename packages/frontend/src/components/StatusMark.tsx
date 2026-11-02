import type { JSX } from 'react'
import clsx from 'clsx'
import type { WorkspaceStatus } from '@yaac/shared/types'

/**
 * A workspace's or session's status as one marker, the same in the sidebar
 * and the read-only pane: an ask waiting on an answer (which wins over the
 * rest), a spinner while running, a slow swell while only background work
 * runs, the unread dot (waiting, not yet seen by the viewer), or a hollow
 * ring for a workspace with no session running. `owner` names whose
 * answer an ask waits on when that is not the viewer's (a teammate's
 * workspace).
 */
export function StatusMark({ status, asking, unread = false, owner }: {
  status: WorkspaceStatus | undefined
  asking?: boolean
  unread?: boolean
  owner?: string
}): JSX.Element | null {
  if (asking === true) {
    const label = `Waiting for ${owner !== undefined ? `${owner}'s` : 'your'} answer`
    return (
      <span
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-rose-500
          text-[9px] font-bold leading-none text-white"
        title={label}
        aria-label={label}
      >
        ?
      </span>
    )
  }
  if (status === 'running') return <BrailleDots className="braille-spinner text-emerald-400" title="Working" />
  if (status === 'background') {
    return <BrailleDots className="braille-spinner braille-breathe text-sky-400" title="Background work running" />
  }
  if (unread) {
    return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
  }
  if (status === 'idle') {
    return <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-text-faint" title="No agent running" />
  }
  return null
}

/** What `StatusMark` shows, in words, for a line of facts. */
export function statusText(status: WorkspaceStatus | undefined, asking: boolean | undefined, owner?: string): string {
  if (asking === true) return `Waiting for ${owner !== undefined ? `${owner}'s` : 'your'} answer`
  if (status === 'running') return 'Working'
  if (status === 'background') return 'Background work running'
  if (status === 'idle') return 'No agent running'
  return 'Waiting'
}

/** The six-dot grid the activity markers animate (index.css). */
function BrailleDots({ className, title }: { className: string; title: string }): JSX.Element {
  return (
    <span className={clsx('shrink-0', className)} title={title} aria-hidden>
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}
