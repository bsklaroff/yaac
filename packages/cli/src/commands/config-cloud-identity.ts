import { api, resolveProjectId } from '#commands/api'

export interface ConfigCloudIdentityOptions {
  clear?: boolean
}

/**
 * `yaac config cloud-identity`: print the cloud identity a project's
 * workspaces act as, set it (`host` for the server's own, or a service
 * account to impersonate), or remove it with `--clear`
 * (docs/cloud-identity.md). Choosing `host` names the identity and warns,
 * since the workspaces then hold everything it may do.
 */
export async function configCloudIdentity(
  project: string,
  identity: string | undefined,
  options: ConfigCloudIdentityOptions,
): Promise<void> {
  const projectId = await resolveProjectId(project)
  if (identity !== undefined && options.clear) throw new Error('Pass an identity or --clear, not both.')
  if (identity === undefined && !options.clear) {
    const [projects, info] = await Promise.all([api.project.list.$get(), api.server['cloud-identity'].$get()])
    const { name, cloudIdentity: setting } = projects.find((p) => p.id === projectId)!
    if (!info.provider) console.log('This server found no cloud identity to lend (it is not running on GCP).')
    console.log(setting === null
      ? `${name}: no cloud identity.`
      : `${name}: ${setting === 'host' ? `host (${info.hostIdentity ?? 'unknown'})` : setting}`)
    return
  }
  const result = await api.project[':projectId']['cloud-identity'].$put({
    param: { projectId },
    json: { identity: identity ?? null },
  })
  if (result.identity === null) {
    console.log('Cloud identity removed.')
    return
  }
  console.log(`Workspaces of this project now act as ${result.identity}.`)
  if (identity === 'host') {
    console.warn(`Warning: sessions in this project run as ${result.identity} and inherit all of its permissions.`)
  }
}
