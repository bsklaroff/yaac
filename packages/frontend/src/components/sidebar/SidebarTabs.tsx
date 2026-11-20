import type { JSX } from 'react'
import clsx from 'clsx'
import { ChatIcon, SiteIcon, WorkflowIcon } from '#lib/icons'
import { unreadWaitingByProject, useUiStore, type SidebarTab } from '#lib/store'
import { useSitesSupported } from '#lib/useSnapshot'
import { useWhoami } from '#lib/viewer'
import type { WorkspaceListEntry } from '@yaac/shared/types'
import { YSegmented } from '#ui'

const TABS = [
  { value: 'workspace', label: 'Workspaces', Icon: ChatIcon },
  { value: 'workflow', label: 'Workflows', Icon: WorkflowIcon },
  { value: 'site', label: 'Sites', Icon: SiteIcon },
] as const

/** The tab the project sidebar shows: the saved one, or Workspaces where the
 *  server runs no sites. */
export function useSidebarTab(): SidebarTab {
  const tab = useUiStore((s) => s.sidebarTab)
  const sites = useSitesSupported()
  return tab === 'site' && !sites ? 'workspace' : tab
}

/**
 * The project sidebar's switch between its workspaces, its workflows and
 * routines, and its sites. Every running workspace is on the Workspaces tab,
 * so while another tab is open a mark on it says when any of them waits
 * for the viewer. In a narrow sidebar the tabs drop to their icons. It is
 * a YSegmented rather than YTabs for the raised look it shares with the
 * new-workspace pane's kind picker.
 */
export function SidebarTabs({ workspaces, className }: {
  /** The project's live workspaces. */
  workspaces: WorkspaceListEntry[]
  className?: string
}): JSX.Element {
  const tab = useSidebarTab()
  const setTab = useUiStore((s) => s.setSidebarTab)
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  const me = useWhoami()?.userId
  const sites = useSitesSupported()
  const waiting = tab === 'workspace' ? 0
    : Object.values(unreadWaitingByProject(workspaces, me, pendingDeleteIds)).reduce((a, b) => a + b, 0)
  return (
    <div className={clsx('@container', className)}>
      <YSegmented
        ariaLabel="Sidebar list"
        value={tab}
        onChange={setTab}
        className="flex w-full *:flex-1 *:justify-center"
        options={TABS.filter((t) => t.value !== 'site' || sites).map(({ value, label, Icon }) => {
          const name = value === 'workspace' && waiting > 0 ? `${label}, ${waiting} waiting for you` : label
          return {
            value,
            ariaLabel: name,
            title: name,
            label: (
              <>
                <Icon size={13} strokeWidth={1.75} aria-hidden className="hidden @max-[14rem]:block" />
                <span className="@max-[14rem]:hidden">{label}</span>
                {name !== label && <span aria-hidden className="size-1.5 shrink-0 bg-warning" />}
              </>
            ),
          }
        })}
      />
    </div>
  )
}
