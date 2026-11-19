import type { JSX } from 'react'
import type { WorkspaceStatus } from '@yaac/shared/types'
import { YStatus, type YStatusKind } from '#ui'

/**
 * A workspace's or session's status as its YStatus mark, the same in the
 * sidebar and the read-only pane: an ask waiting on an answer (which wins
 * over the rest) needs you; running is working; only background work left
 * is `bg`; waiting is done, or `unread` (amber) while the viewer has not
 * yet seen it, which a row or tab says by passing `unread`; no session
 * running is stopped. `owner` names whose answer an ask waits on when that
 * is not the viewer's (a teammate's workspace).
 */
export function StatusMark({ status, asking, unread, owner }: {
  status: WorkspaceStatus | undefined
  asking?: boolean
  unread?: boolean
  owner?: string
}): JSX.Element | null {
  const kind = statusKind(status, asking, unread)
  if (kind === undefined) return null
  return <YStatus kind={kind} title={statusText(status, asking, owner, unread)} />
}

/** The YStatus kind for a workspace's or session's status. */
export function statusKind(status: WorkspaceStatus | undefined, asking: boolean | undefined, unread?: boolean): YStatusKind | undefined {
  if (asking === true) return 'need'
  if (status === 'running') return 'work'
  if (status === 'background') return 'bg'
  if (status === 'idle') return 'stop'
  if (status === 'waiting') return unread === true ? 'unread' : 'done'
  return undefined
}

/** What `StatusMark` shows, in words, for a line of facts. */
export function statusText(status: WorkspaceStatus | undefined, asking: boolean | undefined, owner?: string, unread?: boolean): string {
  if (asking === true) return `Waiting for ${owner !== undefined ? `${owner}'s` : 'your'} answer`
  if (status === 'running') return 'Working'
  if (status === 'background') return 'Background work running'
  if (status === 'idle') return 'No agent running'
  return status === 'waiting' && unread === true ? 'Finished since you looked' : 'Waiting'
}
