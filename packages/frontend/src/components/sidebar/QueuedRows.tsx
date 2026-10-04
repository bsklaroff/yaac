import { Fragment, useState, type JSX, createContext, useContext } from 'react'
import clsx from 'clsx'
import { Collapsible } from '@base-ui/react/collapsible'
import { ChevronIcon, DraftIcon, QueuedIcon } from '#lib/icons'
import { RowMenu } from '#components/sidebar/RowMenu'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { agentLabel } from '#lib/agentLabel'
import { api } from '#lib/api'
import { queuedTitle, clip } from '#lib/queued'
import { useUiStore } from '#lib/store'
import { useCreateWorkspace } from '#lib/useCreateDefaults'
import { relativeAge } from '#lib/time'
import type { DraftWorkspaceEntry, QueuedWorkspaceEntry } from '@yaac/shared/types'

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
 *  be hidden when collapsed). Chains inside it always show in full. */
export function QueuedSet({ parentId }: { parentId: string }): JSX.Element | null {
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
  const failed = entries.filter((e) => e.launchError !== undefined).length
  const open = expanded.has(parentId)
  return (
    <Collapsible.Root open={open} onOpenChange={(next) => setOpen(parentId, next)}>
      <Collapsible.Trigger className="mx-2 flex items-center gap-1 pl-5 pr-2 py-1 text-xs
        text-text-faint outline-none transition hover:text-text-dim">
        <ChevronIcon size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
        {n} queued workspace{n === 1 ? '' : 's'}
        {failed > 0 && <span className="text-danger">· {failed} failed</span>}
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <QueuedRows parentId={parentId} depth={1} />
      </Collapsible.Panel>
    </Collapsible.Root>
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

/** Where a discarded entry's children go, and whether they then run. */
function discardDescription(entry: QueuedWorkspaceEntry, context: QueueContextValue): string {
  const lost = `“${clip(queuedTitle(entry))}” will not run.`
  const n = context.children.get(entry.id)?.length ?? 0
  if (n === 0) return lost
  const them = n === 1 ? 'The workspace queued after it' : `The ${n} workspaces queued after it`
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
 * (docs/queued-workspaces.md). Clicking it edits it; its menu runs it now,
 * edits it, queues another after it, or discards it. A failed launch shows
 * its error until run again. Not selectable (see `sidebarRowIds`).
 */
export function QueuedWorkspaceRow({ entry, depth }: { entry: QueuedWorkspaceEntry; depth: number }): JSX.Element {
  const openCreateWorkspace = useUiStore((s) => s.openCreateWorkspace)
  const context = useContext(QueueContext)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const edit = (): void => openCreateWorkspace({ projectSlug: entry.projectSlug, editId: entry.id })
  const report = (e: unknown): void => setError(e instanceof Error ? e.message : String(e))
  const failure = error ?? entry.launchError

  return (
    <div className="group relative mx-2" style={{ paddingLeft: depth * 12 }}>
      <button
        type="button"
        onClick={edit}
        title={entry.prompt}
        className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition
          hover:bg-surface-2/60"
      >
        <span className="flex items-center gap-2 group-hover:pr-8 max-md:pr-10">
          <QueuedIcon size={11} className="shrink-0 text-text-faint" />
          <span className="truncate text-text-dim">{queuedTitle(entry)}</span>
        </span>
        <span className="flex items-center gap-2 text-xs text-text-faint">
          {failure !== undefined
            ? <span className="truncate text-danger" title={failure}>{failure}</span>
            : <span className="truncate">{agentLabel(entry.tool, entry)} · queued</span>}
          {entry.orphaned === true && <span className="ml-auto shrink-0">parent gone</span>}
        </span>
      </button>

      <RowMenu
        label="Queued workspace actions"
        items={[
          {
            label: 'Run now',
            onSelect: () => {
              setError(null)
              api.workspace.queue.run.$post({ json: { id: entry.id } }).catch(report)
            },
          },
          { label: 'Edit…', onSelect: edit },
          {
            label: 'Queue workspace after this…',
            onSelect: () => openCreateWorkspace({ projectSlug: entry.projectSlug, parent: entry.id, focus: 'prompt' }),
          },
          'separator',
          { label: 'Discard…', onSelect: () => setConfirmDiscard(true) },
        ]}
      />

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard queued workspace?"
        description={discardDescription(entry, context)}
        confirmLabel="Discard"
        onConfirm={() => {
          setConfirmDiscard(false)
          api.workspace.queue.discard.$post({ json: { id: entry.id } }).catch(report)
        }}
      />
    </div>
  )
}

/**
 * The project's draft workspaces (docs/draft-workspaces.md), in a
 * collapsible section at the top of the list.
 */
export function DraftsSection({ drafts }: { drafts: DraftWorkspaceEntry[] }): JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <div role="group" aria-label="Drafts" className="py-1">
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger className="flex w-full items-center gap-1 px-3 py-1 text-xs font-medium
          text-text-faint outline-none transition hover:text-text-dim">
          <ChevronIcon size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
          <span>Drafts</span>
          <span className="text-text-faint/70">{drafts.length}</span>
        </Collapsible.Trigger>
        <Collapsible.Panel>
          {/* Newest first, like the rest of the list. */}
          {[...drafts].reverse().map((d) => <DraftWorkspaceRow key={d.id} draft={d} />)}
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  )
}

/** A saved draft: clicking it reopens the create dialog; its menu can also
 *  create from it right away, ignoring its Start, or discard it. Not
 *  selectable. */
function DraftWorkspaceRow({ draft }: { draft: DraftWorkspaceEntry }): JSX.Element {
  const openCreateWorkspace = useUiStore((s) => s.openCreateWorkspace)
  const createWorkspace = useCreateWorkspace()
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const name = queuedTitle(draft)
  const open = (): void => openCreateWorkspace({ projectSlug: draft.projectSlug, draftId: draft.id, focus: 'prompt' })
  const run = (): void => createWorkspace(draft.projectSlug, draft.tool, {
    model: draft.model ?? '',
    permissionMode: draft.permissionMode,
    mode: draft.mode,
    prompt: draft.prompt,
    ...(draft.title !== undefined ? { title: draft.title } : {}),
    ...(draft.generatedTitle !== undefined ? { shownTitle: draft.generatedTitle } : {}),
    ...(draft.groupId !== undefined ? { groupId: draft.groupId } : {}),
    draftId: draft.id,
  }, draft.branch)

  return (
    <div className="group relative mx-2">
      <button
        type="button"
        onClick={open}
        title={draft.prompt}
        className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition
          hover:bg-surface-2/60"
      >
        <span className="flex items-center gap-2 group-hover:pr-8 max-md:pr-10">
          <DraftIcon size={11} className="shrink-0 text-text-faint" />
          <span className="truncate text-text-dim">{name}</span>
        </span>
        <span className="flex items-center gap-2 text-xs text-text-faint">
          <span className="shrink-0">{relativeAge(draft.updatedAt)}</span>
          <span className="ml-auto truncate">{agentLabel(draft.tool, draft)}</span>
        </span>
      </button>

      <RowMenu
        label="Draft actions"
        items={[
          { label: 'Run now', onSelect: run },
          { label: 'Open…', onSelect: open },
          'separator',
          { label: 'Discard…', onSelect: () => setConfirmDiscard(true) },
        ]}
      />

      <ConfirmDialog
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
    </div>
  )
}
