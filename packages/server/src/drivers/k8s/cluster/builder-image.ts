import { BUILDKIT_DIR } from '@yaac/shared/project-paths'
import { contextHash, imagePrefix } from './image-tags'
import { mirrorRef } from './registry'

/**
 * The sandboxed builder pods' image: BuildKit with a patched buildkitd
 * (k8s/buildkit/Dockerfile), tagged by the build context's hash. `yaac
 * cluster install` builds it and records the digest it pushed, like a
 * pinned mirror's. The builder pods themselves are in `#drivers/k8s/images`.
 */
export async function resolveBuilderImageTag(prefix = imagePrefix()): Promise<string> {
  return `${prefix}-buildkit:${await contextHash(BUILDKIT_DIR)}`
}

/**
 * The builder image's in-cluster ref, by the digest install recorded. Every
 * project's untrusted layers build in it, so an overwritten tag must never
 * reach a builder pod. Lookup-only.
 */
export async function ensureBuilderImage(): Promise<string> {
  return mirrorRef('builder', await resolveBuilderImageTag())
}

/**
 * buildkitd's config, for the builder pods and for install's host daemon.
 *
 * - Gateway frontends are off, so a `# syntax=` line or a frontend image
 *   never runs; callers pass `cmdline` so the built-in Dockerfile frontend
 *   parses every file instead of refusing it.
 * - `plainHttp` names the registries reached over plain HTTP: the main
 *   registry, from wherever this daemon dials it.
 * - Its own GC is off: a builder pod's state dies with the pod, and the
 *   host daemon prunes before install removes it.
 */
export function buildkitdConfig(opts: { plainHttp: string[] }): string {
  return [
    '[worker.oci]',
    '  enabled = true',
    '  snapshotter = "overlayfs"',
    '  gc = false',
    '[worker.containerd]',
    '  enabled = false',
    '[frontend."gateway.v0"]',
    '  enabled = false',
    ...opts.plainHttp.flatMap((host) => [`[registry."${host}"]`, '  http = true']),
    '',
  ].join('\n')
}

/**
 * buildkitd's environment: no cap on a step's log size or rate, which by
 * default clips output past 200KiB/s, so a build's log reaches the client
 * whole.
 */
export const BUILDKITD_ENV: Record<string, string> = {
  BUILDKIT_STEP_LOG_MAX_SIZE: '-1',
  BUILDKIT_STEP_LOG_MAX_SPEED: '-1',
}
