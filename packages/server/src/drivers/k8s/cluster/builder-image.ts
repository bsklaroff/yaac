import {
  registryHasTag,
  registryRef,
} from '#drivers/k8s/container'
import { missingPrebuiltImage } from '#drivers/k8s/image-engine'

/**
 * The digest-pinned podman image the sandboxed builder pods run, mirrored
 * into the local registry at install like the other pinned upstreams. Its
 * podman version tracks the workspace engines' so store metadata stays
 * compatible. Never the workspace's own image, whose binaries the user
 * controls. The builder pods themselves are in `#drivers/k8s/images`.
 */
export const BUILDER_UPSTREAM_IMAGE =
  'quay.io/podman/stable@sha256:25d49cf990843962043942db172c7ef5c6f85012384aada7976aec65906ae209'
export const BUILDER_LOCAL_TAG = 'podman-stable:v5.5'

/** The builder image's in-cluster ref, from the registry. Lookup-only. */
export async function ensureBuilderImage(): Promise<string> {
  if (await registryHasTag(BUILDER_LOCAL_TAG)) return registryRef(BUILDER_LOCAL_TAG)
  throw missingPrebuiltImage('builder', BUILDER_LOCAL_TAG)
}
