import { mirrorRef } from './registry'

/**
 * The digest-pinned podman image the sandboxed builder pods run, mirrored
 * into the local registry at install like the other pinned upstreams. Its
 * podman version tracks the workspace engines' so store metadata stays
 * compatible. Never the workspace's own image, whose binaries the user
 * controls. The builder pods themselves are in `#drivers/k8s/images`.
 */
const BUILDER_PIN = 'sha256:25d49cf990843962043942db172c7ef5c6f85012384aada7976aec65906ae209'
export const BUILDER_UPSTREAM_IMAGE = `quay.io/podman/stable@${BUILDER_PIN}`
/** The mirror tag includes the pin, so re-pinning re-mirrors. */
export const BUILDER_MIRROR_TAG =
  `podman-stable:v5.5-${BUILDER_PIN.slice('sha256:'.length, 'sha256:'.length + 12)}`

/**
 * The builder image's in-cluster ref, by the digest install recorded. Many
 * of the pods that run it are root over node or shared data, so an
 * overwritten tag must never reach them. Lookup-only.
 */
export async function ensureBuilderImage(): Promise<string> {
  return mirrorRef('builder', BUILDER_MIRROR_TAG)
}
