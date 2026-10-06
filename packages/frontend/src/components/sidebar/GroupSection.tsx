import { Fragment, useState, type JSX } from 'react'
import clsx from 'clsx'
import { Collapsible } from '@base-ui/react/collapsible'
import { ChevronIcon, PinIcon } from '#lib/icons'
import { api } from '#lib/api'
import { isUnseenDeath } from '#lib/store'
import { useInlineEdit } from '#lib/useInlineRename'
import { RowMenu } from '#components/sidebar/RowMenu'
import { QueuedSet } from '#components/sidebar/QueuedRows'
import { DeletedWorkspaceRow, ProvisioningRow, WorkspaceRow, type SidebarDrag } from '#components/sidebar/WorkspaceRows'
import type { SidebarGroupSection } from '#components/WorkspaceList'
// The server refuses longer group names, so the name fields stop here.
import { MAX_TITLE_LENGTH } from '@yaac/shared/titles'
import type { WorkspaceGroupSummary } from '@yaac/shared/types'

/**
 * One group: a collapsible section and drop zone holding its live, held and
 * ghost rows. The header shows live members out of the total; its `…` menu
 * renames, pins, shows or hides ghost rows, and deletes (no confirmation,
 * since members just return to the default list).
 *
 * Ghost rows start hidden on each mount. In a section of only ghosts, the
 * caret and the menu item toggle the same thing.
 */
export function GroupSection({
  section,
  shownGroups,
  drag,
  rowIds,
  dropTarget,
  zoneRef,
}: {
  section: SidebarGroupSection
  /** The groups on screen, offered by a member row's group dialog. */
  shownGroups: WorkspaceGroupSummary[]
  drag: SidebarDrag
  /** The whole sidebar's selectable rows, for a member's stop. */
  rowIds: string[]
  /** A drop here would move the dragged workspace into this group. */
  dropTarget: boolean
  zoneRef: (el: HTMLDivElement | null) => void
}): JSX.Element {
  const { group, provisioning, members, held, ghosts } = section
  const [open, setOpen] = useState(true)
  const [showStopped, setShowStopped] = useState(false)
  const onlyGhosts = provisioning.length + members.length + held.length === 0
  const expanded = onlyGhosts ? showStopped : open
  // A failed provisioning row isn't counted as active.
  const active = provisioning.filter((p) => !p.error).length + members.length
  const total = provisioning.length + members.length + held.length + ghosts.length
  // Flag unseen deaths on the header, since ghost rows may be hidden.
  const died = ghosts.filter(isUnseenDeath).length
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
    if (onlyGhosts) setShowStopped(next)
    setOpen(next)
  }
  const toggleStopped = (): void => {
    // Showing ghosts also opens the section.
    if (!showStopped) setOpen(true)
    setShowStopped(!showStopped)
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
      className={clsx('py-1', dropTarget && 'rounded-lg bg-surface-2/40 ring-1 ring-accent/40')}
    >
      <Collapsible.Root open={expanded} onOpenChange={toggleExpanded}>
        <div className="group relative">
          {editing ? (
            <div className="px-3 py-1">
              <input
                ref={inputRef}
                aria-label="Group name"
                defaultValue={seed}
                placeholder="Group name"
                maxLength={MAX_TITLE_LENGTH}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
                className="w-full rounded border border-border-strong bg-bg px-1.5 py-0.5
                  text-xs font-medium text-text outline-none"
              />
            </div>
          ) : (
            <>
              <Collapsible.Trigger className="flex w-full items-center gap-1 px-3 py-1 text-xs font-medium
                text-text-faint outline-none transition hover:text-text-dim group-hover:pr-9 max-md:pr-11">
                <ChevronIcon size={12} className={clsx('shrink-0 transition-transform', expanded && 'rotate-90')} />
                {/* The pin icon is always shown, not only on hover. */}
                {group.pinned && <PinIcon size={10} className="shrink-0 rotate-45" />}
                <span className="truncate">{group.name}</span>
                <span className="text-text-faint/70">({active}/{total})</span>
                {died > 0 && <span className="text-danger">· {died} died</span>}
              </Collapsible.Trigger>

              {/* Outside the trigger, which is itself a button. */}
              <RowMenu
                label="Group actions"
                position="right-2 top-0.5"
                items={[
                  { label: 'Rename', onSelect: startRename },
                  { label: group.pinned ? 'Unpin' : 'Pin', onSelect: togglePinned },
                  ...(ghosts.length > 0
                    ? [{ label: showStopped ? 'Hide stopped workspaces' : 'Show stopped workspaces', onSelect: toggleStopped }]
                    : []),
                  'separator',
                  { label: 'Delete group', onSelect: remove },
                ]}
              />
            </>
          )}
        </div>
        <Collapsible.Panel>
          {/* Provisioning rows lead the section, as they lead the list. */}
          {provisioning.map((p) => (
            <Fragment key={p.workspaceId}>
              <ProvisioningRow entry={p} />
              <QueuedSet parentId={p.workspaceId} />
            </Fragment>
          ))}
          {members.map((s) => (
            <Fragment key={s.workspaceId}>
              <WorkspaceRow workspace={s} shownGroups={shownGroups} drag={drag} rowIds={rowIds} />
              <QueuedSet parentId={s.workspaceId} />
            </Fragment>
          ))}
          {held.map((d) => (
            <Fragment key={d.workspaceId}>
              <DeletedWorkspaceRow entry={d} />
              <QueuedSet parentId={d.workspaceId} />
            </Fragment>
          ))}
          {showStopped && ghosts.map((d) => <DeletedWorkspaceRow key={d.workspaceId} entry={d} />)}
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  )
}
