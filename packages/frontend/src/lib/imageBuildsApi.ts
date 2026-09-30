import { api } from './api'

/**
 * Image-build actions. Build status arrives in the snapshot, but the podman
 * log tail does not, so the build overlay polls it here while open.
 */
export function getImageBuildLog(id: string): Promise<{ log: string }> {
  return api.image.builds[':id'].log.$get({ param: { id } })
}

/** Hide a finished (usually failed) build row. Does not rebuild; the prewarm
 *  sweep keeps backing off a failed chain until its backoff window ends. */
export async function dismissImageBuild(id: string): Promise<void> {
  await api.image.builds[':id'].$delete({ param: { id } })
}

/** Forget a failed build and start it again. */
export async function retryImageBuild(id: string): Promise<void> {
  await api.image.builds[':id'].retry.$post({ param: { id } })
}
