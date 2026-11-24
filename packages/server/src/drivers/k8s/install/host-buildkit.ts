/**
 * The trusted chain (`base`, `tools`) is built with BuildKit on the host,
 * not with podman: an image podman pushes has an OCI config, which has no
 * `SHELL`, and `Dockerfile.default`'s `SHELL` is what gives every derived
 * image its umask (docs/arbitrary-uid-images.md). BuildKit records it.
 *
 * Each layer ends with the normalize step, as a project's does, and the
 * output names what it fixed, so a shipped step that leaves files without
 * group write shows in the install log.
 *
 * The daemon is the builder image (`yaac-buildkit`, which install builds
 * first) run as a container on the host engine for one install, then
 * removed. Its state lives in a named volume, pruned to
 * `HOST_BUILDKIT_KEEP_MB` before the daemon goes, so a later install hits
 * the cache of its newest steps without the volume keeping every layer of
 * base and tools on the user's disk. The next install removes a
 * container an interrupted one left behind, which also ends any build
 * still running in it. Container and volume are named by the data dir, so
 * two installs (or test rigs) on one engine never share a daemon.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
// The data dir identifies the install, whose BuildKit container this is.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { getDataDir } from '@yaac/shared/paths'
import {
  execFileAsync,
  buildContextFiles,
  runStreamingProcess,
  streamBuildContext,
} from '#drivers/k8s/substrate'
import {
  BUILDKITD_ENV,
  NORMALIZE_STEP,
  buildkitdConfig,
  dockerfileFrontendArgs,
  registryAuthFile,
  resolveBuilderImageTag,
  stringHash,
  type ImageLayer,
} from '#drivers/k8s/cluster'
import { buildImage, imageExists, podmanRegistryEndpoint } from './host-images'
import { BUILDKIT_DIR } from '@yaac/shared/project-paths'

/** The cache kept between installs; `buildctl prune` drops the least
 *  recently used records past it. */
const HOST_BUILDKIT_KEEP_MB = 3072

/**
 * Trusted-build timeouts. Ten minutes with no output means the build is
 * stuck; the one-hour total catches a stuck build that keeps printing.
 */
const HOST_BUILD_IDLE_TIMEOUT_MS = 600_000
const HOST_BUILD_TOTAL_TIMEOUT_MS = 3600_000

/** How long the daemon lives at most, so one an interrupted install left
 *  (its `finally` never ran) goes away by itself; `--rm` removes it. */
const HOST_BUILDKIT_LIFETIME_S = 2 * 3600

/** In-container paths: the context, the Dockerfile as built, buildctl's
 *  credentials. */
const CONTEXT_DIR = '/work'
const DOCKERFILE_DIR = '/dockerfile'
const AUTH_FILE = '/root/.docker/config.json'

/** The daemon container's name, which its state volume shares. */
export function hostBuildkitName(): string {
  return `yaac-buildkitd-${stringHash(getDataDir()).slice(0, 8)}`
}

/**
 * The builder image in the host store, built from k8s/buildkit if absent.
 * Install pushes it to the registry afterwards, for the builder pods.
 */
export async function ensureLocalBuilderImage(prefix?: string): Promise<string> {
  const tag = await resolveBuilderImageTag(prefix)
  if (!await imageExists(tag)) await buildImage(tag, path.join(BUILDKIT_DIR, 'Dockerfile'), BUILDKIT_DIR)
  return tag
}

async function podmanExec(name: string, script: string, input?: string): Promise<void> {
  await runStreamingProcess('podman', ['exec', '-i', name, 'sh', '-c', script], {
    input: input === undefined ? undefined : Readable.from([input]),
    logPrefix: '[buildkitd] ',
    timeoutMs: 120_000,
    label: 'podman exec',
    tailLines: 20,
  })
}

/**
 * Build `layers` in order with a host buildkitd and push each to the
 * registry as a zstd image. The caller passes only the missing ones.
 */
export async function buildTrustedLayers(
  layers: ImageLayer[],
  log: (message: string) => void,
  prefix?: string,
  /** A `key=value` label for the daemon container (the e2e owner label). */
  containerLabel?: string,
): Promise<void> {
  const image = await ensureLocalBuilderImage(prefix)
  const endpoint = await podmanRegistryEndpoint()
  const name = hostBuildkitName()
  await execFileAsync('podman', ['rm', '-f', '-t', '0', name]).catch(() => {})
  const config = buildkitdConfig({ plainHttp: [endpoint] })
  await execFileAsync('podman', [
    'run', '-d', '--rm', '--name', name, '--privileged', '--network', 'host',
    ...(containerLabel !== undefined ? ['--label', containerLabel] : []),
    '-v', `${name}:/var/lib/buildkit`,
    '-e', `BUILDKITD_CONFIG=${config}`,
    ...Object.entries(BUILDKITD_ENV).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '--entrypoint', 'sh', image, '-c',
    `printf %s "$BUILDKITD_CONFIG" > /etc/buildkit/buildkitd.toml && exec timeout ${String(HOST_BUILDKIT_LIFETIME_S)} buildkitd --config /etc/buildkit/buildkitd.toml`,
  ], { timeout: 120_000 })
  try {
    await podmanExec(name, 'for i in $(seq 120); do buildctl debug workers >/dev/null 2>&1 && exit 0; sleep 0.5; done; exit 1')
    await podmanExec(name, `umask 077 && mkdir -p ${path.posix.dirname(AUTH_FILE)} && cat > ${AUTH_FILE}`,
      await registryAuthFile(endpoint, '*', 3600))
    for (const layer of layers) {
      log(`  ${layer.tag}`)
      const logPrefix = `[build ${layer.tag}] `
      await streamBuildContext(layer.context, await buildContextFiles(layer.context), logPrefix, (tar) =>
        runStreamingProcess('podman', [
          'exec', '-i', name, 'sh', '-c', `rm -rf ${CONTEXT_DIR} && mkdir -p ${CONTEXT_DIR} && tar -xf - -C ${CONTEXT_DIR}`,
        ], { input: tar, logPrefix, timeoutMs: 600_000, label: 'podman exec tar', tailLines: 20 }))
      // Every image ends with the normalize step, the trusted chain too, so
      // a project's build finds nothing of the chain's to fix.
      const dockerfile = await fs.readFile(layer.dockerfile, 'utf8')
      await podmanExec(name, `mkdir -p ${DOCKERFILE_DIR} && cat > ${DOCKERFILE_DIR}/Dockerfile`,
        `${dockerfile}\n${NORMALIZE_STEP}`)
      const args = [
        'exec', name, 'buildctl', 'build',
        ...dockerfileFrontendArgs(dockerfile),
        '--local', `context=${CONTEXT_DIR}`,
        '--local', `dockerfile=${DOCKERFILE_DIR}`,
        '--output', `type=image,name=${endpoint}/${layer.tag},push=true,compression=zstd,oci-mediatypes=true`,
        '--progress', 'plain',
      ]
      for (const [key, value] of Object.entries(layer.buildArgs ?? {})) {
        args.push('--opt', `build-arg:${key}=${key === 'BASE_IMAGE' ? `${endpoint}/${value}` : value}`)
      }
      await runStreamingProcess('podman', args, {
        logPrefix,
        idleTimeoutMs: HOST_BUILD_IDLE_TIMEOUT_MS,
        timeoutMs: HOST_BUILD_TOTAL_TIMEOUT_MS,
        label: `buildctl build ${layer.tag}`,
        tailLines: 20,
      })
    }
  } finally {
    await execFileAsync('podman', ['exec', name, 'buildctl', 'prune', '--keep-storage', String(HOST_BUILDKIT_KEEP_MB)], {
      timeout: 300_000,
    }).catch((err: unknown) => { log(`  could not prune the BuildKit cache: ${String(err)}`) })
    await execFileAsync('podman', ['rm', '-f', '-t', '0', name]).catch(() => {})
  }
}
