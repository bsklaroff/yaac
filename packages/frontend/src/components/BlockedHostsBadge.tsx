import type { JSX } from 'react'
import clsx from 'clsx'
import { BlockedIcon } from '#lib/icons'
import { api } from '#lib/api'
import { useReadOnly } from '#lib/viewer'
import { ActionsBadge } from '#components/ui/ActionsBadge'

/**
 * Blocked-host count badge whose popover lists the hosts. Each host can be
 * allowed for this workspace, or permanently for the project (added to its
 * egress allowlist so future workspaces inherit it). A teammate's
 * workspace (#lib/viewer) lists the hosts with no actions.
 */
export function BlockedHostsBadge({
  hosts,
  workspaceId,
  iconSize,
  className,
}: {
  hosts: string[]
  /** The workspace these hosts were blocked for. */
  workspaceId: string
  iconSize: number
  /** Positioning and the context-appropriate hover highlight for the trigger. */
  className?: string
}): JSX.Element {
  const readOnly = useReadOnly()
  const allow = (host: string, persist: boolean) => () =>
    api.workspace[':id']['allow-host'].$post({ param: { id: workspaceId }, json: { host, persist } })
  return (
    <ActionsBadge
      label={`${hosts.length} blocked host${hosts.length === 1 ? '' : 's'}`}
      icon={<BlockedIcon size={iconSize} />}
      className={clsx('bg-danger/15 text-danger', className)}
      header={<div className="px-2 pb-0.5 pt-1 text-[11px] font-medium text-text-faint">Blocked hosts</div>}
      items={hosts}
      itemLabel={(host) => host}
      actions={(host) => readOnly ? [] : [
        { label: 'Allow for this workspace', run: allow(host, false) },
        { label: 'Allow permanently for this project', run: allow(host, true) },
      ]}
    />
  )
}
