import { rpc } from './rpc'

/**
 * Image-build registry reads. Build metadata (status, layer, step N/M)
 * arrives in the snapshot; the raw podman log tail is deliberately not in
 * snapshots, so the build overlay polls it here while open.
 */
export function getImageBuildLog(id: string): Promise<{ log: string }> {
  return rpc.image.builds[':id'].log.$get({ param: { id } }).then((r) => r.json())
}

/** Hide a finished (typically failed) build row. Does not rebuild — a failed
 *  chain keeps backing off the prewarm sweep until its window lapses. */
export function dismissImageBuild(id: string): Promise<void> {
  return rpc.image.builds[':id'].$delete({ param: { id } }).then(() => {})
}

/** Rebuild now: forgets the failed entry and re-triggers its build. */
export function retryImageBuild(id: string): Promise<void> {
  return rpc.image.builds[':id'].retry.$post({ param: { id } }).then(() => {})
}
