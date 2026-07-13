import { rpc, unwrap, expectOk } from './rpc'

/**
 * Image-build registry reads. Build metadata (status, layer, step N/M)
 * arrives in the snapshot; the raw podman log tail is deliberately not in
 * snapshots, so the build overlay polls it here while open.
 */
export function getImageBuildLog(id: string): Promise<{ log: string }> {
  return unwrap(rpc.image.builds[':id'].log.$get({ param: { id } }))
}

/** Dismiss a finished (typically failed) build entry. */
export function dismissImageBuild(id: string): Promise<void> {
  return expectOk(rpc.image.builds[':id'].$delete({ param: { id } }))
}
