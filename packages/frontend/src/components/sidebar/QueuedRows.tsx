import { Fragment, useState, type JSX, type ReactNode, createContext, useContext } from 'react'
import clsx from 'clsx'
import { ChevronIcon, DraftIcon, QueuedIcon } from '#lib/icons'
import { ApprovalDetails } from '#components/ApprovalDetails'
import { SidebarRow } from '#components/sidebar/SidebarRow'
import { agentLabel } from '#lib/agentLabel'
import { api } from '#lib/api'
import { fetchFullPrompt, queuedTitle, clip } from '#lib/queued'
import { useUiStore } from '#lib/store'
import { useCreateWorkspace } from '#lib/useCreateDefaults'
import { relativeAge, timeUntil, useNow, useTimeZone } from '#lib/time'
import { useReadOnly } from '#lib/viewer'
import { formatInZone } from '@yaac/shared/schedule'
import type { DraftWorkspaceEntry, LaunchApprovalRequest, QueuedWorkspaceEntry } from '@yaac/shared/types'
import { YButton, YConfirm, YListSection } from '#ui'

/** The row a discarded entry's children would move under, as its discard
 *  confirmation describes it. */
export interface QueueParent {
  name: string
  kind: 'live' | 'held' | 'queued' | 'gone'
}

export interface QueueContextValue {
  /** Queued workspaces by the id they wait on. */
  children: Map<string, QueuedWorkspaceEntry[]>
  parent: (id: string) => QueueParent
  /** Workspace ids whose queued set is expanded. */
  expanded: ReadonlySet<string>
  setOpen: (id: string, open: boolean) => void
}

/** A context rather than props, since any row (live, provisioning, held or
 *  queued) can have entries nested under it. */
export const QueueContext = createContext<QueueContextValue>({
  children: new Map(),
  parent: () => ({ name: '', kind: 'gone' }),
  expanded: new Set(),
  setOpen: () => {},
})

/** Everything queued under a workspace row, behind one expander that counts
 *  entries at every depth, including failed launches (which would otherwise
 *  be hidden when collapsed). Chains inside it always show in full. A
 *  group's set of entries `waiting` for room says so, since it follows the
 *  group's last row rather than belonging to it. */
export function QueuedSet({ parentId, waiting = false }: { parentId: string; waiting?: boolean }): JSX.Element | null {
  const { children, expanded, setOpen } = useContext(QueueContext)
  if (!children.has(parentId)) return null
  const entries: QueuedWorkspaceEntry[] = []
  const walk = (id: string): void => {
    for (const e of children.get(id) ?? []) {
      entries.push(e)
      walk(e.id)
    }
  }
  walk(parentId)
  const n = entries.length
  const awaiting = entries.filter((e) => e.awaitingApproval !== undefined).length
  const failed = entries.filter((e) => e.launchError !== undefined).length - awaiting
  const open = expanded.has(parentId)
  return (
    <>
      <YButton
        variant="bare"
        aria-expanded={open}
        onClick={() => setOpen(parentId, !open)}
        className="flex items-center gap-1 py-1 pl-5 pr-2 text-md text-subtle transition hover:text-muted"
      >
        <ChevronIcon size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
        {waiting ? `${n} waiting for room` : `${n} queued workspace${n === 1 ? '' : 's'}`}
        {awaiting > 0 && <span className="text-warning">· {awaiting} awaiting approval</span>}
        {failed > 0 && <span className="text-danger">· {failed} failed</span>}
      </YButton>
      {open && <QueuedRows parentId={parentId} depth={1} />}
    </>
  )
}

/** The queued workspaces waiting on `parentId`, each followed by its own
 *  chain, indented one step per level. */
export function QueuedRows({ parentId, depth }: { parentId: string; depth: number }): JSX.Element | null {
  const { children } = useContext(QueueContext)
  const entries = children.get(parentId)
  if (entries === undefined) return null
  return (
    <>
      {entries.map((e) => (
        <Fragment key={e.id}>
          <QueuedWorkspaceRow entry={e} depth={depth} />
          <QueuedRows parentId={e.id} depth={depth + 1} />
        </Fragment>
      ))}
    </>
  )
}

/** Where a discarded entry's children go, and whether they then run. A
 *  scheduled entry hands them its start time. */
function discardDescription(entry: QueuedWorkspaceEntry, context: QueueContextValue, timeZone: string): string {
  const lost = `“${clip(queuedTitle(entry))}” will not run.`
  const n = context.children.get(entry.id)?.length ?? 0
  if (n === 0) return lost
  const them = n === 1 ? 'The workspace queued after it' : `The ${n} workspaces queued after it`
  if (entry.startAt !== undefined) return `${lost} ${them} will start at about ${formatInZone(new Date(entry.startAt), timeZone)} instead.`
  if (entry.parentWorkspaceId === undefined && entry.parentQueuedId === undefined) {
    return `${lost} ${them} will wait for room in ${n === 1 ? 'its' : 'their'} group instead.`
  }
  const parent = context.parent(entry.parentWorkspaceId ?? entry.parentQueuedId ?? '')
  const name = `“${clip(parent.name, 40)}”`
  switch (parent.kind) {
    case 'live': return `${lost} ${them} will start when ${name} stops instead.`
    case 'queued': return `${lost} ${them} will wait on ${name} instead.`
    case 'held': return `${lost} ${them} will move under ${name}, which is stopped — they wait there until you run them.`
    case 'gone': return `${lost} ${them} will wait at the top of the list until you run them.`
  }
}

/**
 * A queued workspace: a create saved to start when the row above it stops
 * (docs/queued-workspaces.md), or at a time (docs/routines.md), which it
 * shows relative to now and in full on hover. Clicking it edits it; its
 * menu runs it now, edits it, queues another after it, or discards it. A
 * failed launch shows its error until run again, and one that needs a
 * person's approval says so, and its menu reviews what it would run before
 * approving exactly that. Not selectable (see `sidebarRowIds`).
 */
export function QueuedWorkspaceRow({ entry, depth }: { entry: QueuedWorkspaceEntry; depth: number }): JSX.Element {
  const openNewWorkspace = useUiStore((s) => s.openNewWorkspace)
  const context = useContext(QueueContext)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  // What the review dialog shows, frozen when it opens: what is approved.
  const [review, setReview] = useState<LaunchApprovalRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const edit = (): void => openNewWorkspace({ projectId: entry.projectId, editId: entry.id })
  const report = (e: unknown): void => setError(e instanceof Error ? e.message : String(e))
  const failure = error ?? entry.launchError
  const readOnly = useReadOnly()
  const zone = useTimeZone()
  const now = useNow()

  return (
    <>
      <SidebarRow
        label={queuedTitle(entry)}
        onSelect={readOnly ? undefined : edit}
        rowProps={{ title: entry.prompt, style: { paddingLeft: 10 + depth * 12 } }}
        mark={<QueuedIcon size={11} className="text-subtle" />}
        title={queuedTitle(entry)}
        meta={(
          <>
            {error === null && entry.awaitingApproval !== undefined
              ? <span className="truncate text-warning" title={failure}>awaiting your approval · review it from its menu</span>
              : failure !== undefined
              ? <span className="truncate text-danger" title={failure}>{failure}</span>
              : (
                <>
                  {entry.startAt !== undefined && (
                    <span className="shrink-0" title={`${formatInZone(new Date(entry.startAt), zone)} ${zone}`}>
                      in ~{timeUntil(entry.startAt, now)}
                    </span>
                  )}
                  <span className="truncate">{agentLabel(entry.tool, entry)}</span>
                  {entry.waitingForRoom === true
                    ? <span className="shrink-0">waiting for room</span>
                    : entry.startAt === undefined && <span className="shrink-0">queued</span>}
                </>
              )}
            {entry.orphaned === true && <span className="ml-auto shrink-0">parent gone</span>}
          </>
        )}
        menu={{
          label: 'Queued workspace actions',
          items: [
            entry.awaitingApproval !== undefined
              ? { label: 'Review and approve…', onSelect: () => setReview(entry.awaitingApproval ?? null) }
              : {
                label: 'Run now',
                onSelect: () => {
                  setError(null)
                  api.workspace.queue.run.$post({ json: { id: entry.id } }).catch(report)
                },
              },
            { label: 'Edit…', onSelect: edit },
            {
              label: 'Queue workspace after this…',
              onSelect: () => openNewWorkspace({ projectId: entry.projectId, parent: entry.id }),
            },
            'separator',
            { label: 'Discard…', onSelect: () => setConfirmDiscard(true) },
          ],
        }}
      />

      {review !== null && (
        <YConfirm
          open
          onOpenChange={(open) => { if (!open) setReview(null) }}
          title="Approve and run?"
          description="It runs with run secrets. Approving runs exactly what is shown here, as you, and approves it for later runs."
          confirmLabel="Approve and run"
          destructive={false}
          onConfirm={() => {
            setReview(null)
            setError(null)
            const approve = { workflowId: review.workflowId, commits: review.commits }
            api.workspace.queue.run.$post({ json: { id: entry.id, approve } }).catch(report)
          }}
        >
          <ApprovalDetails request={review} />
        </YConfirm>
      )}

      <YConfirm
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard queued workspace?"
        description={discardDescription(entry, context, zone)}
        confirmLabel="Discard"
        onConfirm={() => {
          setConfirmDiscard(false)
          api.workspace.queue.discard.$post({ json: { id: entry.id } }).catch(report)
        }}
      />
    </>
  )
}

/** A collapsible section at the top of the list (Drafts, Scheduled,
 *  Routines), with its count. */
export function SidebarSection({ label, count, children }: { label: string; count: number; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <div role="group" aria-label={label}>
      <YListSection label={label} count={count} open={open} onToggle={() => setOpen(!open)} />
      {open && children}
    </div>
  )
}

/** The project's draft workspaces (docs/draft-workspaces.md), newest first. */
export function DraftsSection({ drafts }: { drafts: DraftWorkspaceEntry[] }): JSX.Element {
  return (
    <SidebarSection label="Drafts" count={drafts.length}>
      {[...drafts].reverse().map((d) => <DraftWorkspaceRow key={d.id} draft={d} />)}
    </SidebarSection>
  )
}

/** Queued workspaces that start at a time, soonest first, each with the
 *  chain queued after it. */
export function ScheduledSection({ entries }: { entries: QueuedWorkspaceEntry[] }): JSX.Element {
  return (
    <SidebarSection label="Scheduled" count={entries.length}>
      {entries.map((e) => (
        <Fragment key={e.id}>
          <QueuedWorkspaceRow entry={e} depth={0} />
          <QueuedRows parentId={e.id} depth={1} />
        </Fragment>
      ))}
    </SidebarSection>
  )
}

/** A saved draft: clicking it reopens the new-workspace pane on it; its menu can also
 *  create from it right away, ignoring its Start, or discard it. Not
 *  selectable. */
function DraftWorkspaceRow({ draft }: { draft: DraftWorkspaceEntry }): JSX.Element {
  const openNewWorkspace = useUiStore((s) => s.openNewWorkspace)
  const createWorkspace = useCreateWorkspace()
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const name = queuedTitle(draft)
  const readOnly = useReadOnly()
  const open = (): void => openNewWorkspace({ projectId: draft.projectId, draftId: draft.id })
  // The snapshot holds only a preview of the prompt. A failed fetch opens
  // the draft instead, whose pane reports it.
  const run = (): void => {
    fetchFullPrompt(draft.id).then((prompt) => createWorkspace({
      ...draft,
      prompt,
      ...(draft.generatedTitle !== undefined ? { shownTitle: draft.generatedTitle } : {}),
      draftId: draft.id,
    }), open)
  }

  return (
    <>
      <SidebarRow
        label={name}
        onSelect={readOnly ? undefined : open}
        rowProps={{ title: draft.prompt }}
        mark={<DraftIcon size={11} className="text-subtle" />}
        title={name}
        meta={(
          <>
            <span className="shrink-0">{relativeAge(draft.updatedAt)}</span>
            <span className="ml-auto truncate">{agentLabel(draft.tool, draft)}</span>
          </>
        )}
        menu={{
          label: 'Draft actions',
          items: [
            { label: 'Run now', onSelect: run },
            { label: 'Open…', onSelect: open },
            'separator',
            { label: 'Discard…', onSelect: () => setConfirmDiscard(true) },
          ],
        }}
      />

      <YConfirm
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard draft?"
        description={`“${clip(name)}” will be deleted.`}
        confirmLabel="Discard"
        onConfirm={() => {
          setConfirmDiscard(false)
          api.workspace.draft.discard.$post({ json: { id: draft.id } })
            .catch((e: unknown) => console.error('draft discard failed', e))
        }}
      />
    </>
  )
}
