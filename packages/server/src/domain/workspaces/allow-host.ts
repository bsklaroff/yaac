import { workspaceDriver } from '#drivers/driver'
import { addAllowedHostToProjectConfig } from '#domain/projects'
import { resolveWorkspaceContainer } from './resolve'

/**
 * Let a workspace reach a host its egress denied (the webapp's click-to-allow
 * action).
 *
 * With `persist`, the host is written to the project's yaac-config.json so
 * future workspaces inherit it, and the runtime also widens every running
 * workspace of the project, since "allow everywhere" includes those. The
 * config write goes first, so a failure there widens nothing.
 */
export async function allowWorkspaceHost(
  idOrName: string,
  host: string,
  opts: { persist: boolean },
): Promise<void> {
  const target = await resolveWorkspaceContainer(idOrName, { requireRunning: true })
  if (opts.persist) await addAllowedHostToProjectConfig(target.projectId, host)
  await workspaceDriver().allowHost(
    { workspaceId: target.workspaceId, projectId: target.projectId },
    host,
    { fanOutToProject: opts.persist },
  )
}
