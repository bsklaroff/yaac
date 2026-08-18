import {
  registryHasTag,
  registryRef,
} from '#drivers/k8s/container'
import { missingPrebuiltImage } from '#drivers/k8s/image-engine'

/**
 * Digest-pinned upstream image the sandboxed builder pods run — podman +
 * coreutils, mirrored into the local registry like the cluster's other
 * pinned upstreams (the digest IS the pin; no content-hash tag). Pinned
 * near the worktree engines' podman major so store metadata stays
 * compatible. Never the worktree's own image: its binaries are
 * user-customizable and must not run yaac-driven builds.
 *
 * It sits here rather than beside the builder pods it runs because the
 * mirroring is install-time substrate work — the same shape as registry:2,
 * Envoy and the gVisor installer's curl — while the pods themselves are a
 * server-side feature (#drivers/k8s/images) that only ever looks the tag
 * up.
 */
export const BUILDER_UPSTREAM_IMAGE =
  'quay.io/podman/stable@sha256:25d49cf990843962043942db172c7ef5c6f85012384aada7976aec65906ae209'
export const BUILDER_LOCAL_TAG = 'podman-stable:v5.5'

/** The builder image's in-cluster ref, from the registry. Lookup-only. */
export async function ensureBuilderImage(): Promise<string> {
  if (await registryHasTag(BUILDER_LOCAL_TAG)) return registryRef(BUILDER_LOCAL_TAG)
  throw missingPrebuiltImage('builder', BUILDER_LOCAL_TAG)
}
