import { rpc } from './rpc'

/**
 * Image-build registry reads. Build metadata (status, layer, step N/M)
 * arrives in the snapshot; the raw podman log tail is deliberately not in
 * snapshots, so the build overlay polls it here while open.
 */
export function getImageBuildLog(id: string): Promise<{ log: string }> {
  return rpc.image.builds[':id'].log.$get({ param: { id } }).then((r) => r.json())
}

/** Dismiss a finished (typically failed) build entry. */
export function dismissImageBuild(id: string): Promise<void> {
  return rpc.image.builds[':id'].$delete({ param: { id } }).then(() => {})
}
