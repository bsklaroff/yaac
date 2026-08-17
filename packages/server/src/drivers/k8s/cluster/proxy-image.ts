import path from 'node:path'
import {
  buildImage,
  contextHash,
  failImageBuild,
  finishImageBuild,
  ingestImageBuildLine,
  missingPrebuiltImage,
  registerImageBuild,
} from '#drivers/k8s/image-engine'
import { imageExists, pushImageToRegistry, registryHasTag, registryRef } from '#drivers/k8s/container'
import { PROXY_DIR } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import { serverLog } from '#log'

/**
 * The egress proxy's own image: a yaac-shipped build context (k8s/proxy),
 * content-hash tagged like every other one, so an unchanged source tree
 * costs a registry HEAD.
 *
 * It lives beside the cluster's other install-time images rather than in
 * the egress folder with its client, because WHO builds it is the point:
 * `yaac cluster install` does, on the CLI machine, while the proxy client
 * only ever looks the tag up (see missingPrebuiltImage).
 */

/**
 * The image tag, without starting or building anything — the content of
 * the proxy build context, so it doubles as the fingerprint the deployed
 * Deployment is compared against.
 */
export async function resolveProxyImageTag(image = testEnv.proxyImage): Promise<string> {
  return `${image}:${await contextHash(PROXY_DIR)}`
}

/** The proxy image's in-cluster ref, from the registry. Lookup-only. */
export async function ensureProxyImage(image = testEnv.proxyImage): Promise<string> {
  const localTag = await resolveProxyImageTag(image)
  if (await registryHasTag(localTag)) return registryRef(localTag)
  throw missingPrebuiltImage('Proxy', localTag)
}

/** Build-or-skip the proxy image on host podman and push it. Install-time only. */
export async function buildProxyImage(image = testEnv.proxyImage): Promise<string> {
  const localTag = await resolveProxyImageTag(image)
  if (await registryHasTag(localTag)) return registryRef(localTag)

  if (!await imageExists(localTag)) {
    // Track the build in the shared registry so it surfaces in the webapp's
    // "building" UX like every other image build. It has no owning project
    // (shared infrastructure), so it registers with an empty projectSlugs.
    const id = registerImageBuild({ tag: localTag, layer: 'proxy', action: 'build', reason: 'session' })
    serverLog(`[build] starting ${localTag} (proxy sidecar)`)
    try {
      await buildImage(localTag, path.join(PROXY_DIR, 'Dockerfile'), PROXY_DIR, undefined, {
        onLog: (line) => ingestImageBuildLine(id, line),
      })
      finishImageBuild(id)
    } catch (err) {
      failImageBuild(id, err instanceof Error ? err.message : String(err))
      throw err
    }
  }
  return pushImageToRegistry(localTag)
}
