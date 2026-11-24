import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ContainerlessBadge } from '#components/ContainerlessBadge'
import { ChatViewToggles } from '#components/ConversationView'
import { ReadOnlyTranscript } from '#components/ReadOnlyTranscript'
import { StatusMark, statusText } from '#components/StatusMark'
import { PaneBarLeading, paneBarClass } from '#components/PaneBar'
import { api } from '#lib/api'
import { workspaceAgentLabel } from '#lib/agentLabel'
import { RestartIcon, TerminalIcon } from '#lib/icons'
import { isLocked } from '#lib/steps'
import { isUnseenDeath } from '#lib/store'
import { relativeAge } from '#lib/time'
import { patchStopped, refetchStopped, useRerunStopped, useRestartStopped } from '#lib/useStoppedWorkspaces'
import { WorkspaceLogs } from '#components/WorkspaceLogs'
import { useReadOnly, useTeammateName, useWhoami } from '#lib/viewer'
import { useIsMobile } from '#lib/viewport'
import { describeWorkspaceDeathReason } from '@yaac/shared/death-reason'
import type { StoppedWorkspaceEntry, WorkspaceListEntry } from '@yaac/shared/types'
import { YButton, YConfirm, YEmptyState } from '#ui'

/** What the read-only pane shows: a teammate's running workspace, or any
 *  stopped one (the user's own or a teammate's). */
export type ReadOnlySubject =
  | { kind: 'live'; entry: WorkspaceListEntry }
  | { kind: 'stopped'; entry: StoppedWorkspaceEntry }

/**
 * The main pane for a workspace the user can read but not drive: a title
 * bar, a line of facts about it, and its conversations. A running one is
 * followed as it happens, its status shown as the sidebar shows it.
 * Terminals, chat and files are left out, since attaching to them grants
 * control (docs/multi-user.md "Authorization"). A bar where the live pane's
 * composer sits carries its width and condensed toggles.
 *
 * The user's own stopped workspace also gets a Restart action, or for a
 * non-interactive one, whose terminal logs show in place of conversations
 * it never had, Rerun actions (docs/workspace-steps.md). A site's release
 * shows its logs too, with neither, since only its site starts another
 * (docs/public-sites.md). Opening any
 * stopped one that died unseen marks it seen by the caller, a teammate's
 * included, since each user has their own dot. The mark is sent at most
 * once per id per page load, so a failing write (whose refetch brings the
 * row back unseen) cannot loop.
 */
export function ReadOnlyWorkspace({ subject }: { subject: ReadOnlySubject | undefined }): JSX.Element {
  const isMobile = useIsMobile()
  const readOnly = useReadOnly()
  const owner = useTeammateName()
  const restart = useRestartStopped()
  const rerun = useRerunStopped()
  const [confirmRestart, setConfirmRestart] = useState(false)
  const entry = subject?.entry
  const title = entry ? entry.title || entry.prompt || 'New workspace' : ''
  const stopped = subject?.kind === 'stopped' ? subject.entry : undefined
  const showsLogs = stopped !== undefined && isLocked(stopped)

  const queryClient = useQueryClient()
  const me = useWhoami()?.userId
  const { mutate: markSeen } = useMutation({
    mutationFn: ({ entry: e }: { entry: StoppedWorkspaceEntry; me: string }) =>
      api.workspace['mark-death-seen'].$post({ json: { projectId: e.projectId, workspaceId: e.workspaceId } }),
    onMutate: ({ entry: e, me: userId }) => patchStopped(queryClient, e.projectId,
      (x) => (x.workspaceId === e.workspaceId ? { ...x, deathSeenBy: [...x.deathSeenBy, userId] } : x)),
    onError: (_err, { entry: e }) => refetchStopped(queryClient, e.projectId),
  })
  const marked = useRef(new Set<string>())
  useEffect(() => {
    if (me === undefined || stopped === undefined || !isUnseenDeath(stopped, me)) return
    if (marked.current.has(stopped.workspaceId)) return
    marked.current.add(stopped.workspaceId)
    markSeen({ entry: stopped, me })
  }, [me, stopped, markSeen])

  return (
    <main className="@container flex h-full min-w-0 flex-col">
      <header className={paneBarClass(isMobile)}>
        <PaneBarLeading />
        <span className="titlebar-drag min-w-0 flex-1 truncate font-medium text-muted">{title}</span>
        {subject && <ContainerlessBadge />}
      </header>
      {subject && showsLogs && stopped ? (
        <>
          <Facts subject={subject} {...(owner !== undefined ? { owner } : {})} />
          <WorkspaceLogs key={stopped.workspaceId} workspaceId={stopped.workspaceId} />
          {!readOnly && stopped.site === undefined && (
            <div className="flex shrink-0 items-center justify-end gap-2 p-2">
              <YButton onClick={() => rerun(stopped, true)}>Rerun interactively</YButton>
              <YButton variant="primary" icon={RestartIcon} onClick={() => rerun(stopped, false)}>Rerun</YButton>
            </div>
          )}
        </>
      ) : subject ? (
        <>
          <Facts subject={subject} {...(owner !== undefined ? { owner } : {})} />
          <ReadOnlyTranscript
            key={subject.entry.workspaceId}
            workspaceId={subject.entry.workspaceId}
            conversations={subject.entry.conversations}
            {...(subject.kind === 'live' ? { liveSessions: subject.entry.sessions } : {})}
            {...(subject.entry.prompt !== undefined ? { prompt: subject.entry.prompt } : {})}
            live={subject.kind === 'live'}
            {...(owner !== undefined ? { owner } : {})}
            footer={
              <div className="flex items-center p-2">
                <ChatViewToggles />
                {stopped && !readOnly && (
                  <YButton variant="primary" icon={RestartIcon} onClick={() => setConfirmRestart(true)} className="ml-auto">
                    Restart
                  </YButton>

                )}
              </div>
            }
          />
        </>
      ) : (
        <YEmptyState
          className="flex-1"
          icon={TerminalIcon}
          title="No workspace selected"
          description="Pick one of their workspaces to read its conversations."
        />
      )}
      {stopped && (
        <YConfirm
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
function Facts({ subject, owner }: { subject: ReadOnlySubject; owner?: string }): JSX.Element {
  const { entry } = subject
  const facts: [string, ReactNode][] = [
    ['Agent', workspaceAgentLabel(entry)],
    ['Created', relativeAge(entry.createdAt) || '—'],
  ]
  if (subject.kind === 'live') {
    const { status, asking } = subject.entry
    facts.push(['Status', (
      <span className="flex items-center gap-1.5">
        <StatusMark status={status} asking={asking === true} {...(owner !== undefined ? { owner } : {})} />
        {statusText(status, asking, owner)}
      </span>
    )])
  } else {
    const e = subject.entry
    facts.push(['Last active', relativeAge(e.lastActiveAt) || '—'])
    facts.push([e.deathReason ? 'Died' : e.endedAtNextRun ? 'Ended at next run' : e.timedOut ? 'Timed out' : 'Stopped',
      relativeAge(e.stoppedAt) || '—'])
    if (e.deathReason) facts.push(['Cause', describeWorkspaceDeathReason(e.deathReason, e.deathDetail)])
    if (e.stepsOutcome) facts.push(['Steps', e.stepsOutcome])
  }
  return (
    <dl className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-b border-line px-3 pb-2 pt-1 text-md">
      {facts.map(([term, value]) => (
        <div key={term} className="flex min-w-0 gap-1.5">
          <dt className="shrink-0 text-subtle">{term}</dt>
          <dd className="min-w-0 text-muted">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
