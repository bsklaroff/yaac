import type { ComponentProps, JSX } from 'react'
import { SiteIcon, WorkflowIcon } from '#lib/icons'
import { GroupSection } from '#components/sidebar/GroupSection'
import { ObjectRow, type ObjectRowProps } from '#components/sidebar/ObjectRow'
import { useRoutineRow } from '#components/sidebar/RoutineRows'
import { siteState, useSiteActions } from '#components/SitePane'
import { useWorkflowActions } from '#components/WorkflowPane'
import type { RoutineEntry, SiteSummary, WorkflowSummary } from '@yaac/shared/types'

/** A workflow's row content and actions, for its section and its group. */
export function useWorkflowRow(workflow: WorkflowSummary): ObjectRowProps {
  const actions = useWorkflowActions(workflow)
  return {
    icon: WorkflowIcon,
    name: workflow.name,
    detail: (
      <>
        <span className="truncate">{workflow.repos.length > 0 ? workflow.repos.join(', ') : 'no repo'}</span>
        {workflow.init && <span className="ml-auto shrink-0 rounded bg-surface-3 px-1 text-[10px]" title="Runs at workspace start">at start</span>}
      </>
    ),
    object: { kind: 'workflow', id: workflow.id },
    projectId: workflow.projectId,
    items: [
      { label: 'Run now', onSelect: actions.runNow },
      { label: 'Run…', onSelect: () => actions.openRun() },
      { label: 'Schedule…', onSelect: () => actions.openRun(true) },
      { label: 'Run interactively…', onSelect: actions.runInteractively },
      { label: 'Edit…', onSelect: actions.edit },
      'separator',
      { label: 'Delete…', onSelect: actions.remove },
    ],
    action: { label: 'Run now', onClick: actions.runNow },
    ...(actions.error !== null ? { failure: actions.error } : {}),
    dialogs: actions.dialog,
  }
}

/** A site's row content and actions, for its section and its group. */
export function useSiteRow(site: SiteSummary): ObjectRowProps {
  const actions = useSiteActions(site)
  const failure = actions.error ?? (site.lastDeploy?.outcome === 'failed' ? site.lastDeploy.error ?? 'deploy failed' : undefined)
  return {
    icon: SiteIcon,
    name: site.name,
    detail: (
      <>
        {site.hostname !== undefined
          ? <span className="truncate font-mono">{site.hostname}</span>
          : <span className="truncate">unpublished</span>}
        <span className={`ml-auto shrink-0 ${site.awaitingApproval === true ? 'text-warning' : ''}`}>{siteState(site)}</span>
      </>
    ),
    object: { kind: 'site', id: site.name },
    projectId: site.projectId,
    items: [
      ...(actions.canDeploy && site.deploy === undefined && site.awaitingApproval === true
        ? [{ label: 'Review…', onSelect: () => actions.ask('approve') }] : []),
      ...(actions.canDeploy && site.deploy === undefined ? [{ label: 'Deploy…', onSelect: () => actions.ask('deploy') }] : []),
      ...(actions.canEnd && site.live !== undefined ? [{ label: 'Stop…', onSelect: () => actions.ask('stop') }] : []),
      ...(actions.canDeploy && site.live === undefined && site.deploy === undefined && site.lastDeploy !== undefined
        ? [{ label: 'Start', onSelect: actions.start }] : []),
      ...(site.hostname !== undefined
        ? [{ label: 'Open site', onSelect: () => window.open(`https://${site.hostname}`, '_blank', 'noopener'), view: true as const }] : []),
      ...(actions.canDeploy ? [{ label: 'Edit…', onSelect: actions.edit }] : []),
      ...(actions.canPublish ? [{ label: site.published ? 'Move…' : 'Publish…', onSelect: () => actions.ask('publish') }] : []),
      ...(actions.canEnd && site.published ? [{ label: 'Unpublish…', onSelect: () => actions.ask('unpublish') }] : []),
      ...(actions.canEnd ? ['separator' as const, { label: 'Delete…', onSelect: () => actions.ask('delete') }] : []),
    ],
    ...(failure !== undefined ? { failure } : {}),
    dialogs: actions.dialog,
  }
}

/** A shown group's section props, less the header its owner gives it. */
export type OwnedGroupProps = Omit<ComponentProps<typeof GroupSection>, 'object'>

/** An object's row, heading its owned group's runs when the group is on
 *  screen (`GroupSection`), else alone. */
function ObjectItem({ row, group }: { row: ObjectRowProps; group: OwnedGroupProps | undefined }): JSX.Element {
  return group !== undefined ? <GroupSection {...group} object={row} /> : <ObjectRow {...row} />
}

export function WorkflowItem({ workflow, group }: { workflow: WorkflowSummary; group: OwnedGroupProps | undefined }): JSX.Element {
  return <ObjectItem row={useWorkflowRow(workflow)} group={group} />
}

export function RoutineItem({ routine, group }: { routine: RoutineEntry; group: OwnedGroupProps | undefined }): JSX.Element {
  return <ObjectItem row={useRoutineRow(routine)} group={group} />
}

export function SiteItem({ site, group }: { site: SiteSummary; group: OwnedGroupProps | undefined }): JSX.Element {
  return <ObjectItem row={useSiteRow(site)} group={group} />
}
