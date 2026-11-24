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

/** The lint rule every layered Dockerfile's bare `ARG BASE_IMAGE` trips,
 *  though the build always supplies the value. */
const SKIPPED_LINT_RULE = 'InvalidDefaultArgInFrom'

/**
 * The value of a Dockerfile's `check` parser directive, read as BuildKit's
 * `ParseDirective` reads it: from the leading run of `# key=value` lines
 * after any BOM and shebang line, which ends at the first line that is not
 * a `syntax`, `escape` or `check` directive, and cut at its first space.
 */
function checkDirective(dockerfile: string): string | undefined {
  const lines = dockerfile.replace(/^﻿/, '').split('\n')
  if (lines[0]?.startsWith('#!')) lines.shift()
  for (const line of lines) {
    const m = /^#\s*([a-zA-Z][a-zA-Z0-9]*)\s*=\s*(.+?)\s*$/.exec(line)
    const key = m?.[1].toLowerCase()
    if (key === 'check') return m![2].split(' ')[0]
    if (key !== 'syntax' && key !== 'escape') return undefined
  }
  return undefined
}

/**
 * The frontend options a `buildctl build` of `dockerfile` passes. `cmdline`
 * parses every file with the built-in Dockerfile frontend, since gateway
 * frontends are off. BuildKit reads a file's own `# check=` directive only
 * when no check build-arg is given, so the build-arg is that directive with
 * SKIPPED_LINT_RULE added to its `skip` list, and every other part (`error`,
 * `experimental`, one BuildKit refuses) kept as written.
 */
export function dockerfileFrontendArgs(dockerfile: string): string[] {
  const directive = checkDirective(dockerfile)
  const parts = directive === undefined ? [] : directive.split(';')
  const i = parts.findIndex((p) => p.split('=')[0].trim() === 'skip')
  const skipped = i < 0 ? '' : parts[i].slice(parts[i].indexOf('=') + 1).trim()
  if (i < 0) parts.push(`skip=${SKIPPED_LINT_RULE}`)
  else if (skipped !== 'all') parts[i] = `skip=${skipped ? `${skipped},` : ''}${SKIPPED_LINT_RULE}`
  return [
    '--frontend', 'dockerfile.v0',
    '--opt', 'cmdline=dockerfile.v0',
    '--opt', `build-arg:BUILDKIT_DOCKERFILE_CHECK=${parts.join(';')}`,
  ]
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
