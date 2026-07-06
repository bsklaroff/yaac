import { api } from './apiClient'

/**
 * Image-build registry reads. Build metadata (status, layer, step N/M)
 * arrives in the snapshot; the raw podman log tail is deliberately not in
 * snapshots, so the build overlay polls it here while open.
 */
export async function getImageBuildLog(id: string): Promise<{ log: string }> {
  return api.get<{ log: string }>(`/image/builds/${encodeURIComponent(id)}/log`)
}

/** Dismiss a finished (typically failed) build entry. */
export async function dismissImageBuild(id: string): Promise<void> {
  return api.del<void>(`/image/builds/${encodeURIComponent(id)}`)
}
