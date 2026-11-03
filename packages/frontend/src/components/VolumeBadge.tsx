import type { JSX } from 'react'
import { VolumeIcon } from '#lib/icons'
import { useVolumes } from '#lib/volumes'

/**
 * Workspace-bar label naming the project volume this workspace has
 * attached (docs/workspace-volumes.md), found as the volume whose
 * holder it is. Nothing without one, or on a server without volumes.
 */
export function VolumeBadge({ projectId, workspaceId }: { projectId: string; workspaceId: string }): JSX.Element | null {
  const volume = useVolumes(projectId)?.find((v) => v.holder?.workspaceId === workspaceId)
  if (volume === undefined) return null
  return (
    <span
      title={`Volume “${volume.name}” is attached, at $YAAC_VOLUME_DIR`}
      className="flex h-6 min-w-0 shrink items-center gap-1 rounded px-1.5 text-[11px] text-text-dim"
    >
      <VolumeIcon size={11} className="shrink-0" />
      <span className="truncate font-mono">{volume.name}</span>
    </span>
  )
}
