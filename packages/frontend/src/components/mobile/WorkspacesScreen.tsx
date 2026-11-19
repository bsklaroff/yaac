import type { JSX } from 'react'
import { HomeSessionList } from '#components/home/HomeSessionList'
import type { HomeRow } from '#components/home/homeRows'
import { MobileHeader } from '#components/mobile/MobileHeader'
import { ListActions, ListBadges, ListTitle, WorkspaceList, type ProjectScope } from '#components/WorkspaceList'
import { InboxIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'
import type { ProjectSummary } from '@yaac/shared/types'
import { YButton } from '#ui'

/**
 * The middle mobile screen: the active project's workspaces, or on Home
 * every project's sessions by status with a way to the inbox. Same list and
 * header actions as the desktop sidebar, with a back button to the projects
 * screen instead of the hide-sidebar toggle.
 */
export function WorkspacesScreen({ scope, connected, onBack, home }: {
  scope: ProjectScope
  connected: boolean
  onBack: () => void
  home?: { rows: HomeRow[]; projects: ProjectSummary[] }
}): JSX.Element {
  const openHome = useUiStore((s) => s.openHome)
  const setMobileScreen = useUiStore((s) => s.setMobileScreen)
  // The pane shows the inbox only with no session selected.
  const showInbox = (): void => { openHome(); setMobileScreen('pane') }
  if (home) {
    return (
      <>
        <MobileHeader
          onBack={onBack}
          backLabel="Back to projects"
          title={<span className="font-semibold">Home</span>}
          actions={<YButton variant="ghost" size="lg" icon={InboxIcon} aria-label="Inbox" onClick={showInbox} />}
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          <HomeSessionList rows={home.rows} projects={home.projects} />
        </div>
      </>
    )
  }
  return (
    <>
      <MobileHeader
        onBack={onBack}
        backLabel="Back to projects"
        title={<ListTitle scope={scope} />}
        actions={<ListActions projectId={scope.projectId} connected={connected} />}
      />
      <ListBadges projectIds={scope.projectId !== null ? [scope.projectId] : []} className="shrink-0 px-3 py-2" />
      <WorkspaceList {...scope} />
    </>
  )
}
