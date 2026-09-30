import os from 'node:os'
import path from 'node:path'

/**
 * Where kind-byo keeps its install (`pnpm kind-byo`, kind-byo.ts). Imports
 * only node builtins because vitest.config.ts reads it.
 */
export interface KindByoLayout {
  /** The install's data dir: the ganesha export, and where both classes land. */
  dataDir: string
  /** Its client-local dir, `<dataDir>-client`, as for any install. */
  clientDir: string
  /** kind-byo's own kubeconfig, never merged into the default one. */
  kubeconfig: string
  /**
   * Let's Encrypt's staging roots, which kind-byo's tailnet certificates
   * chain to; clients trust them via `NODE_EXTRA_CA_CERTS`.
   */
  stagingCa: string
}

export function kindByoLayout(): KindByoLayout {
  const dataDir = path.resolve(process.env.KIND_BYO_DATA_DIR ?? path.join(os.homedir(), '.yaac-byo'))
  const clientDir = `${dataDir}-client`
  return {
    dataDir,
    clientDir,
    kubeconfig: path.join(clientDir, 'kind-byo.kubeconfig'),
    stagingCa: path.join(clientDir, 'letsencrypt-staging-roots.pem'),
  }
}

/**
 * Which cluster the k8s tiers run against: the ordinary kind rig, or
 * kind-byo (`YAAC_TEST_BACKEND=byo`, set by the `e2e-byo` project).
 */
export function testBackend(): 'kind' | 'byo' {
  return process.env.YAAC_TEST_BACKEND === 'byo' ? 'byo' : 'kind'
}
