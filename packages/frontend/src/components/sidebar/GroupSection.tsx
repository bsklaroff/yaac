import { Fragment, useState, type FormEvent, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation } from '@tanstack/react-query'
import { PinIcon } from '#lib/icons'
import { api } from '#lib/api'
import { unseenDeaths, useUiStore } from '#lib/store'
import { useWhoami } from '#lib/viewer'
import { useStoppedWorkspaces } from '#lib/useStoppedWorkspaces'
import { useInlineEdit } from '#lib/useInlineRename'
import { RowMenu } from '#components/sidebar/RowMenu'
import { ObjectRow, type ObjectRowProps } from '#components/sidebar/ObjectRow'
import { QueuedSet } from '#components/sidebar/QueuedRows'
import { roomKey } from '#lib/queued'
import { StoppedRows } from '#components/sidebar/StoppedRows'
import { isTerminating, ProvisioningRow, StoppedWorkspaceRow, WorkspaceRow } from '#components/sidebar/WorkspaceRows'
import { groupDisplay, type SidebarGroupSection } from '#components/WorkspaceList'
// The server refuses longer group names, so the name fields stop here.
import { MAX_TITLE_LENGTH } from '@yaac/shared/titles'
import type { WorkspaceGroupSummary } from '@yaac/shared/types'
import { YButton, YConfirm, YDialog, YDialogClose, YDialogDescription, YDialogTitle, YInput, YListSection, YNumberInput } from '#ui'

/**
 * One group: a collapsible section and drop zone holding its live, held and
 * ghost rows, and the queued workspaces waiting for room in it. The header
 * shows its live workspaces (out of its workspace limit, if it has one) and its
 * stopped members; its `…` menu renames, pins, sets the workspace limit, shows
 * or hides ghost rows, and deletes. A delete needs no confirmation, since
 * members just return to the default list, unless workspaces wait for room
 * in the group: the default list has no limit, so they would all start.
 *
 * An owned group is headed by its owner's row instead (`object`), with the
 * runs indented under it.
 *
 * Ghost rows are the group's other stopped members, fetched a page at a
 * time while shown. Whether they are shown, and whether the group is
 * collapsed, live in the store, because while the ghosts are on screen the
 * Stopped section leaves them out (`groupDisplay`). In a section of only
 * ghosts, the caret and the menu item toggle the same thing.
 */
export function GroupSection({
  section,
  dragId,
  dropTarget,
  zoneRef,
  elsewhere,
  hidden,
  notice,
  object,
}: {
  section: SidebarGroupSection
  /** The workspace being dragged right now, if any. */
  dragId: string | null
  /** A drop here would move the dragged workspace into this group. */
  dropTarget: boolean
  zoneRef: (el: HTMLDivElement | null) => void
  /** Stopped workspaces with a row elsewhere (held, restarting), which the
   *  server leaves out of the ghost list. */
  elsewhere: string[]
  /** Workspaces never drawn as ghosts: `elsewhere`, and live ones. */
  hidden: ReadonlySet<string>
  /** Why the last drop into this group was refused (say, at its limit). */
  notice?: string
  /** The named workflow, routine or site that owns the group, whose row
   *  heads it in place of the group's own header. It is renamed, pinned and
   *  deleted with its owner, so its menu offers only the limit and the
   *  stopped runs beside the owner's actions. */
  object?: ObjectRowProps
}): JSX.Element {
  const { group, provisioning, members, held } = section
  const collapsed = useUiStore((s) => s.collapsedGroups.includes(group.groupId))
  const showStopped = useUiStore((s) => s.stoppedShownGroups.includes(group.groupId))
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  const setGroupCollapsed = useUiStore((s) => s.setGroupCollapsed)
  const setGroupShowsStopped = useUiStore((s) => s.setGroupShowsStopped)
  const { onlyGhosts, expanded, ownsGhosts } = groupDisplay(section, { collapsed, showStopped })
  const ghosts = useStoppedWorkspaces(group.projectId, { group: group.groupId, exclude: elsewhere }, {
    enabled: ownsGhosts,
    version: String(group.stoppedCount),
    hidden,
  })
  // Failed provisioning rows and stopping members aren't counted as active.
  const active = provisioning.filter((p) => !p.error).length
    + members.filter((w) => !isTerminating(w, pendingDeleteIds)).length
  const stopped = held.length + group.stoppedCount
  const limit = group.workspaceLimit
  const [settingLimit, setSettingLimit] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Flag unseen deaths on the header, since ghost rows may be hidden.
  const me = useWhoami()?.userId
  const died = unseenDeaths(group, me)
  const {
    editing,
    seed,
    inputRef,
    start: startRename,
    handleKeyDown,
    handleBlur,
  } = useInlineEdit(group.name, (next) => {
    api.workspace.group.rename.$post({ json: { projectId: group.projectId, groupId: group.groupId, name: next } })
      .catch((e: unknown) => console.error('group rename failed', e))
  })

  // With only ghosts, the caret sets both, so the state carries over when a
  // live row returns.
  const toggleExpanded = (next: boolean): void => {
    if (onlyGhosts) setGroupShowsStopped(group.groupId, next)
    setGroupCollapsed(group.groupId, !next)
  }
  const toggleStopped = (): void => {
    // Showing ghosts also opens the section.
    if (!showStopped) setGroupCollapsed(group.groupId, false)
    setGroupShowsStopped(group.groupId, !showStopped)
  }
  const togglePinned = (): void => {
    api.workspace.group['set-pinned'].$post({
      json: { projectId: group.projectId, groupId: group.groupId, pinned: !group.pinned },
    })
      .catch((e: unknown) => console.error('group pin failed', e))
  }
  const remove = (): void => {
    api.workspace.group.delete.$post({ json: { projectId: group.projectId, groupId: group.groupId } })
      .catch((e: unknown) => console.error('group delete failed', e))
  }

  return (
    <div
      ref={zoneRef}
      role="group"
      aria-label={group.name}
      className={clsx(dropTarget && 'bg-selected/40 ring-1 ring-accent/40')}
    >
      {object !== undefined ? (
        <ObjectRow
          {...object}
          items={[
            ...object.items,
            'separator',
            // A site's next release runs beside its live one until it
            // takes over, so a limit there would refuse every deploy.
            ...(object.object.kind !== 'site' ? [{ label: 'Run limit…', onSelect: () => setSettingLimit(true) }] : []),
            ...(group.stoppedCount > 0 || showStopped
              ? [{ label: showStopped ? 'Hide stopped runs' : 'Show stopped runs', onSelect: toggleStopped, view: true as const }]
              : []),
          ]}
          runs={{ expanded, onToggle: toggleExpanded, live: active, ...(limit !== undefined ? { limit } : {}), stopped, died }}
        />
      ) : editing ? (
        <div className="px-2.5 py-1">
          <YInput
            ref={inputRef}
            aria-label="Group name"
            defaultValue={seed}
            placeholder="Group name"
            maxLength={MAX_TITLE_LENGTH}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            className="w-full font-medium"
          />
        </div>
      ) : (
        <YListSection
          className="group/row"
          label={(
            <span className="flex min-w-0 items-center gap-1.5">
              {/* The pin icon is always shown, not only on hover. */}
              {group.pinned && <PinIcon size={10} className="shrink-0 rotate-45" />}
              <span className="truncate">{group.name}</span>
              <span
                className={clsx('shrink-0 tabular-nums', limit !== undefined && active >= limit ? 'text-warning/80' : 'text-subtle')}
                title={limit !== undefined ? `${active} live of a limit of ${limit}` : `${active} live`}
              >
                ({active}{limit !== undefined && `/${limit}`})
              </span>
              {stopped > 0 && <span className="shrink-0">{stopped} stopped</span>}
              {died > 0 && <span className="shrink-0 text-danger">{died} died</span>}
            </span>
          )}
          open={expanded}
          onToggle={() => toggleExpanded(!expanded)}
          actions={(
            <RowMenu
              label="Group actions"
              hoverOnly
              items={[
                { label: 'Rename', onSelect: startRename },
                { label: group.pinned ? 'Unpin' : 'Pin', onSelect: togglePinned },
                { label: 'Workspace limit…', onSelect: () => setSettingLimit(true) },
                ...(group.stoppedCount > 0 || showStopped
                  ? [{ label: showStopped ? 'Hide stopped workspaces' : 'Show stopped workspaces', onSelect: toggleStopped, view: true as const }]
                  : []),
                'separator',
                { label: 'Delete group', onSelect: () => (section.waiting.length > 0 ? setConfirmDelete(true) : remove()) },
              ]}
            />
          )}
        />
      )}
      {notice !== undefined && <p className="px-3 pb-1 pl-7 text-md text-danger">{notice}</p>}
      {expanded && (
        <div className={object !== undefined ? 'pl-3' : undefined}>
          {/* Provisioning rows lead the section, as they lead the list. */}
          {provisioning.map((p) => (
            <Fragment key={p.workspaceId}>
              <ProvisioningRow entry={p} />
              <QueuedSet parentId={p.workspaceId} />
            </Fragment>
          ))}
          {members.map((s) => (
            <Fragment key={s.workspaceId}>
              <WorkspaceRow workspace={s} dragging={dragId === s.workspaceId} />
              <QueuedSet parentId={s.workspaceId} />
            </Fragment>
          ))}
          {held.map((d) => (
            <Fragment key={d.workspaceId}>
              <StoppedWorkspaceRow entry={d} />
              <QueuedSet parentId={d.workspaceId} />
            </Fragment>
          ))}
          <QueuedSet parentId={roomKey(group.groupId)} waiting />
          {ownsGhosts && <StoppedRows list={ghosts} />}
        </div>
      )}
      <WorkspaceLimitDialog group={group} open={settingLimit} onOpenChange={setSettingLimit} />
      <YConfirm
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete group?"
        description={`${section.waiting.length} queued ${section.waiting.length === 1 ? 'workspace waits' : 'workspaces wait'} `
          + `for room in “${group.name}”. With the group gone, ${section.waiting.length === 1 ? 'it starts' : 'they all start'} now.`}
        confirmLabel="Delete and start them"
        onConfirm={() => {
          setConfirmDelete(false)
          remove()
        }}
      />
    </div>
  )
}

/**
 * Set or clear how many live workspaces a group may hold
 * (docs/workspace-groups.md). Lowering it below what is running stops
 * nothing.
 */
function WorkspaceLimitDialog({ group, open, onOpenChange }: {
  group: WorkspaceGroupSummary
  open: boolean
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const save = useMutation({
    mutationFn: (workspaceLimit: number | null) => api.workspace.group['set-limit'].$post({
      json: { projectId: group.projectId, groupId: group.groupId, workspaceLimit },
    }),
    onSuccess: () => onOpenChange(false),
  })
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const raw = new FormData(event.currentTarget).get('limit')
    const text = typeof raw === 'string' ? raw.trim() : ''
    save.mutate(text === '' ? null : Number(text))
  }
  return (
    <YDialog
      open={open}
      onOpenChange={(next) => { if (!save.isPending) { save.reset(); onOpenChange(next) } }}
      variant="form"
      className="w-[340px]"
    >
      <YDialogTitle className="text-base font-semibold">Workspace limit</YDialogTitle>
      <YDialogDescription className="mt-1 text-md text-muted">
        The most workspaces “{group.name}” runs at once. Starting, restarting or moving in one more is
        refused, and queued workspaces wait for room. Leave it empty for no limit.
      </YDialogDescription>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
        <YNumberInput
          name="limit"
          min={1}
          step={1}
          autoFocus
          aria-label="Workspace limit"
          placeholder="No limit"
          defaultValue={group.workspaceLimit ?? ''}
          className="h-8 bg-sunken"
        />
        {save.error && <p className="text-md text-danger">{save.error.message}</p>}
        <div className="flex justify-end gap-2">
          <YDialogClose disabled={save.isPending} render={<YButton variant="ghost" />}>Cancel</YDialogClose>
          <YButton type="submit" variant="primary" disabled={save.isPending}>Save</YButton>
        </div>
      </form>
    </YDialog>
  )
}
