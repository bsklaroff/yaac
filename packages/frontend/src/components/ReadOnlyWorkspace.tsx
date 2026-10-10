import { useEffect, useRef, useState, type JSX } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ContainerlessBadge } from '#components/ContainerlessBadge'
import { ReadOnlyTranscript } from '#components/ReadOnlyTranscript'
import { ChatViewToggles } from '#components/WorkspaceChat'
import { PaneBarLeading, paneBarClass } from '#components/WorkspaceView'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { EmptyState } from '#components/ui/EmptyState'
import { api } from '#lib/api'
import { agentLabel, workspaceModel } from '#lib/agentLabel'
import { RestartIcon, TerminalIcon } from '#lib/icons'
import { isUnseenDeath } from '#lib/store'
import { relativeAge } from '#lib/time'
import { patchStopped, refetchStopped, useRestartStopped } from '#lib/useStoppedWorkspaces'
import { useReadOnly } from '#lib/viewer'
import { useIsMobile } from '#lib/viewport'
import { describeWorkspaceDeathReason } from '@yaac/shared/death-reason'
import type { StoppedWorkspaceEntry, WorkspaceListEntry } from '@yaac/shared/types'

/** What the read-only pane shows: a teammate's running workspace, or any
 *  stopped one (the user's own or a teammate's). */
export type ReadOnlySubject =
  | { kind: 'live'; entry: WorkspaceListEntry }
  | { kind: 'stopped'; entry: StoppedWorkspaceEntry }

/**
 * The main pane for a workspace the user can read but not drive: a title
 * bar, a line of facts about it, and its conversations. A running one is
 * refetched while it runs. Terminals, chat and files are left out, since
 * attaching to them grants control (docs/multi-user.md "Authorization").
 * A bar where the live pane's composer sits carries its width and condensed
 * toggles.
 *
 * The user's own stopped workspace also gets a Restart action, and opening
 * one that died unseen marks it seen. That write is the owner's alone, so a
 * teammate's view never makes it, and it happens at most once per id per
 * page load, so a failing write (whose refetch brings the row back unseen)
 * cannot loop.
 */
export function ReadOnlyWorkspace({ subject }: { subject: ReadOnlySubject | undefined }): JSX.Element {
  const isMobile = useIsMobile()
  const readOnly = useReadOnly()
  const restart = useRestartStopped()
  const [confirmRestart, setConfirmRestart] = useState(false)
  const entry = subject?.entry
  const title = entry ? entry.title || entry.prompt || 'New workspace' : ''
  const stopped = subject?.kind === 'stopped' ? subject.entry : undefined

  const queryClient = useQueryClient()
  const { mutate: markSeen } = useMutation({
    mutationFn: (e: StoppedWorkspaceEntry) =>
      api.workspace['mark-death-seen'].$post({ json: { projectId: e.projectId, workspaceId: e.workspaceId } }),
    onMutate: (e) => patchStopped(queryClient, e.projectId,
      (x) => (x.workspaceId === e.workspaceId ? { ...x, seen: true } : x)),
    onError: (_err, e) => refetchStopped(queryClient, e.projectId),
  })
  const marked = useRef(new Set<string>())
  useEffect(() => {
    if (readOnly || stopped === undefined || !isUnseenDeath(stopped) || marked.current.has(stopped.workspaceId)) return
    marked.current.add(stopped.workspaceId)
    markSeen(stopped)
  }, [readOnly, stopped, markSeen])

  return (
    <main className="@container flex h-full min-w-0 flex-col">
      <header className={paneBarClass(isMobile)}>
        <PaneBarLeading />
        <span className="titlebar-drag min-w-0 flex-1 truncate font-medium text-text-dim">{title}</span>
        {subject && <ContainerlessBadge />}
      </header>
      {subject ? (
        <>
          <Facts subject={subject} />
          <ReadOnlyTranscript
            key={subject.entry.workspaceId}
            workspaceId={subject.entry.workspaceId}
            sessions={subject.entry.agentSessions}
            {...(subject.entry.prompt !== undefined ? { prompt: subject.entry.prompt } : {})}
            live={subject.kind === 'live'}
            footer={
              <div className="flex items-center p-2">
                <ChatViewToggles />
                {stopped && !readOnly && (
                  <button
                    type="button"
                    onClick={() => setConfirmRestart(true)}
                    className="ml-auto flex h-8 items-center gap-1.5 rounded-full bg-text px-3.5 text-xs
                      font-medium text-bg hover:opacity-90"
                  >
                    <RestartIcon size={12} />
                    Restart
                  </button>
                )}
              </div>
            }
          />
        </>
      ) : (
        <EmptyState
          className="flex-1"
          icon={TerminalIcon}
          title="No workspace selected"
          description="Pick one of their workspaces to read its conversation."
        />
      )}
      {stopped && (
        <ConfirmDialog
          open={confirmRestart}
          onOpenChange={setConfirmRestart}
          destructive={false}
          title="Restart this workspace?"
          description={title}
          confirmLabel="Restart"
          onConfirm={() => {
            setConfirmRestart(false)
            restart(stopped)
          }}
        />
      )}
    </main>
  )
}

/** The workspace's facts as one wrapping line under the title bar. */
function Facts({ subject }: { subject: ReadOnlySubject }): JSX.Element {
  const { entry } = subject
  const facts: [string, string][] = [
    ['Agent', agentLabel(entry.tool, workspaceModel(entry))],
    ['Created', relativeAge(entry.createdAt) || '—'],
  ]
  if (subject.kind === 'live') {
    facts.push(['Status', subject.entry.status])
  } else {
    const e = subject.entry
    facts.push(['Last active', relativeAge(e.lastActiveAt) || '—'])
    facts.push([e.deathReason ? 'Died' : 'Stopped', relativeAge(e.stoppedAt) || '—'])
    if (e.deathReason) facts.push(['Cause', describeWorkspaceDeathReason(e.deathReason, e.deathDetail)])
  }
  return (
    <dl className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-b border-hairline-soft px-2 pb-2 pt-1 text-xs">
      {facts.map(([term, value]) => (
        <div key={term} className="flex min-w-0 gap-1.5">
          <dt className="shrink-0 text-text-faint">{term}</dt>
          <dd className="min-w-0 text-text-dim">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
