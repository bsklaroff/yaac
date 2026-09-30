import { workspaceDriver } from '#drivers/driver'
import { addAllowedHostToProjectConfig } from '#domain/projects'
import { resolveWorkspaceContainer } from './resolve'

/**
 * Let a workspace reach a host its egress denied — the webapp's
 * click-to-allow action.
 *
 * Two decisions live here, and both are the reason this is a mediator verb
 * rather than a call straight through to the runtime.
 *
 * `persist` is the first: whether the widen outlives this workspace. Written
 * into the project's yaac-config.json, it is inherited by every future
 * workspace of the project — durable project policy, so the write belongs
 * above the runtime whatever realizes the live half.
 *
 * The second is that persisting implies the fan-out. A user who says "allow
 * this everywhere" means the sibling workspaces they already have running too,
 * not just the ones they create next; without it a persisted host would look
 * ignored until each was recreated. So the config write comes first — a
 * failure there means nothing was widened anywhere — and the runtime is then
 * asked to widen the project's whole running set.
 */
export async function allowWorkspaceHost(
  idOrName: string,
  host: string,
  opts: { persist: boolean },
): Promise<void> {
  const target = await resolveWorkspaceContainer(idOrName, { requireRunning: true })
  if (opts.persist) await addAllowedHostToProjectConfig(target.projectSlug, host)
  await workspaceDriver().allowHost(
    { workspaceId: target.workspaceId, projectSlug: target.projectSlug },
    host,
    { fanOutToProject: opts.persist },
  )
}
