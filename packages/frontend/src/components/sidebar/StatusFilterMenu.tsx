import type { JSX } from 'react'
import clsx from 'clsx'
import { Menu } from '@base-ui/react/menu'
import { MENU_ITEM, POPUP } from '#components/ui/menu'
import { CheckIcon, FilterIcon } from '#lib/icons'
import { SIDEBAR_STATUSES, useUiStore, type SidebarStatus } from '#lib/store'

const LABELS: Record<SidebarStatus, string> = {
  waiting: 'Waiting',
  running: 'Running',
  background: 'Monitoring',
  stopped: 'Stopped',
}

/**
 * The sidebar's status filter, beside the search box: a menu of checkboxes,
 * one per status, narrowing the list to the checked ones. With none checked
 * every row shows. The trigger is tinted and counts the checked statuses
 * while a filter is on.
 */
export function StatusFilterMenu(): JSX.Element {
  const statuses = useUiStore((s) => s.sidebarStatuses)
  const setStatuses = useUiStore((s) => s.setSidebarStatuses)
  const toggle = (status: SidebarStatus, on: boolean): void =>
    setStatuses(SIDEBAR_STATUSES.filter((v) => (v === status ? on : statuses.includes(v))))
  return (
    <Menu.Root>
      <Menu.Trigger
        title="Filter by status"
        aria-label="Filter by status"
        className={clsx(
          `flex shrink-0 items-center gap-1 rounded-md border px-2 text-xs outline-none transition
          hover:text-text data-[popup-open]:border-border-strong max-md:px-3`,
          statuses.length > 0 ? 'border-accent/60 text-accent' : 'border-border text-text-faint',
        )}
      >
        <FilterIcon size={13} />
        {statuses.length > 0 && <span>{statuses.length}</span>}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4}>
          <Menu.Popup className={clsx('min-w-[160px]', POPUP)}>
            {SIDEBAR_STATUSES.map((status) => (
              <Menu.CheckboxItem
                key={status}
                checked={statuses.includes(status)}
                onCheckedChange={(on) => toggle(status, on)}
                className={MENU_ITEM}
              >
                <span className="w-3 shrink-0">
                  <Menu.CheckboxItemIndicator><CheckIcon size={12} /></Menu.CheckboxItemIndicator>
                </span>
                <span className="text-text">{LABELS[status]}</span>
              </Menu.CheckboxItem>
            ))}
            {statuses.length > 0 && (
              <>
                <Menu.Separator className="my-1 h-px bg-border" />
                <Menu.Item className={MENU_ITEM} onClick={() => setStatuses([])}>
                  <span className="w-3 shrink-0" />
                  Show all
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
