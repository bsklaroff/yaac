import { api } from './api'

/**
 * Image-build registry reads. Build metadata (status, layer, step N/M)
 * arrives in the snapshot; the raw podman log tail is deliberately not in
 * snapshots, so the build overlay polls it here while open.
 */
export function getImageBuildLog(id: string): Promise<{ log: string }> {
  return api.image.builds[':id'].log.$get({ param: { id } })
}

/** Hide a finished (typically failed) build row. Does not rebuild — a failed
 *  chain keeps backing off the prewarm sweep until its window lapses. */
export async function dismissImageBuild(id: string): Promise<void> {
  await api.image.builds[':id'].$delete({ param: { id } })
}

/** Rebuild now: forgets the failed entry and re-triggers its build. */
export async function retryImageBuild(id: string): Promise<void> {
  await api.image.builds[':id'].retry.$post({ param: { id } })
}
