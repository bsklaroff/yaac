import {
  contextHash,
  missingPrebuiltImage,
} from '#drivers/k8s/image-engine'
import { registryHasTag, registryRef } from '#drivers/k8s/container'
import { PROXY_DIR } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'

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
