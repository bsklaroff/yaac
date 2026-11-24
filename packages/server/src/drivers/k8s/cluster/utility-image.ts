import { mirrorRef } from './registry'

/**
 * The digest-pinned podman image that root utility pods run: the node-local
 * sweeps and root removals, the old-node-tree removal, a workspace Job's
 * `volume-root` init container and `yaac cluster check`'s probes. None of
 * them uses podman itself; it is a small root image yaac already mirrors.
 * Mirrored into the local registry at install like the other pinned
 * upstreams. Never the workspace's own image, whose binaries the user
 * controls.
 */
const UTILITY_PIN = 'sha256:25d49cf990843962043942db172c7ef5c6f85012384aada7976aec65906ae209'
export const UTILITY_UPSTREAM_IMAGE = `quay.io/podman/stable@${UTILITY_PIN}`
/** The mirror tag includes the pin, so re-pinning re-mirrors. */
export const UTILITY_MIRROR_TAG =
  `podman-stable:v5.5-${UTILITY_PIN.slice('sha256:'.length, 'sha256:'.length + 12)}`

/**
 * The utility image's in-cluster ref, by the digest install recorded. Its
 * pods are root over node or shared data, so an overwritten tag must never
 * reach them. Lookup-only.
 */
export async function ensureUtilityImage(): Promise<string> {
  return mirrorRef('utility', UTILITY_MIRROR_TAG)
}
