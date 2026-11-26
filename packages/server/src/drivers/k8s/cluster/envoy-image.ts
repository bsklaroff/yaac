/**
 * Envoy, digest-pinned and mirrored into the local registry so nodes pull
 * it without upstream access: the site router, the registry gate, the kind
 * fronting and the token endpoint run it. The pin must be the multi-arch
 * index digest: a single-platform digest crashloops on other architectures.
 */
const ENVOY_VERSION = 'v1.34.0'
const ENVOY_PIN = 'sha256:45d37d848802f98a5647cb7522b4c1c42e0e0e775913d8e253ef3a5856bef986'
export const ENVOY_UPSTREAM_IMAGE = `docker.io/envoyproxy/envoy@${ENVOY_PIN}`
/** The mirror tag includes the pin, so re-pinning re-mirrors (the mirror
 *  skips tags already present). */
export const ENVOY_MIRROR_TAG =
  `envoyproxy/envoy:${ENVOY_VERSION}-${ENVOY_PIN.slice('sha256:'.length, 'sha256:'.length + 12)}`
