import { contextHash, prebuiltRef } from '#drivers/k8s/image-engine'
import { PROXY_DIR } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'

/**
 * The egress proxy's image (build context `k8s/proxy`, content-hash tagged).
 * `yaac cluster install` builds it; the server only looks the tag up.
 */

/** The proxy image tag, from the build context's hash. Also compared
 *  against the deployed Deployment. */
export async function resolveProxyImageTag(image = testEnv.proxyImage): Promise<string> {
  return `${image}:${await contextHash(PROXY_DIR)}`
}

/** The proxy image's in-cluster ref, from the registry. Lookup-only. */
export async function ensureProxyImage(image = testEnv.proxyImage): Promise<string> {
  return prebuiltRef('Proxy', await resolveProxyImageTag(image))
}
