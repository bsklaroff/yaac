import type { JSX } from 'react'
import { MobileHeader } from '#components/mobile/MobileHeader'
import { ListActions, ListBadges, ListTitle, WorkspaceList, type ProjectScope } from '#components/WorkspaceList'

/**
 * The middle mobile screen: the active project's workspaces. Same list and
 * header actions as the desktop sidebar, with a back button to the projects
 * screen instead of the hide-sidebar toggle.
 */
export function WorkspacesScreen({ scope, connected, onBack }: {
  scope: ProjectScope
  connected: boolean
  onBack: () => void
}): JSX.Element {
  return (
    <>
      <MobileHeader
        onBack={onBack}
        backLabel="Back to projects"
        title={<ListTitle scope={scope} />}
        actions={<ListActions projectId={scope.projectId} connected={connected} />}
      />
      <ListBadges scope={scope} className="shrink-0 px-3 py-2" />
      <WorkspaceList {...scope} />
    </>
  )
}
