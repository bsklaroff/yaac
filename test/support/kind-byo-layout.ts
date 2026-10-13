import os from 'node:os'
import path from 'node:path'

/**
 * Where kind-byo keeps its install (`pnpm kind-byo`, kind-byo.ts), and the
 * storage classes it and each e2e-byo file apply. Imports only node
 * builtins: vitest.config.ts reads it, and every k8s test file loads it
 * through storage-claims.ts, which should not load kind-byo.ts.
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

export const KIND_BYO_NFS_NAMESPACE = 'kind-byo-nfs'
export const GANESHA_NAME = 'nfs-ganesha'
/** Where the csi node plugin mounts from — the ganesha Service's name. */
const KIND_BYO_NFS_SERVER = `${GANESHA_NAME}.${KIND_BYO_NFS_NAMESPACE}.svc.cluster.local`
/** The export's pseudo path, which a class names as its `share`. */
export const KIND_BYO_NFS_SHARE = '/export'

type StorageClass = Record<string, unknown> & { kind: string; metadata: { name: string } }

/**
 * A local-path class whose one volume lands at `<nodePath>/<pattern>`,
 * with `reclaimPolicy: Delete` as an operator might write it, so install's
 * `Retain` patch is exercised.
 */
export function localPathClass(name: string, nodePath: string, pattern: string, isDefault: boolean): StorageClass {
  return {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: {
      name,
      ...(isDefault ? { annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } } : {}),
    },
    provisioner: 'rancher.io/local-path',
    volumeBindingMode: 'WaitForFirstConsumer',
    reclaimPolicy: 'Delete',
    parameters: { nodePath, pathPattern: pattern, allowUnsafePathPattern: 'true' },
  }
}

/**
 * An NFS class over the ganesha export with volumes at `subDir`: a
 * per-claim template for kind-byo's class, a fixed dir for an e2e-byo
 * file's. Left naive (`Delete`, no `actimeo`, no `mountPermissions`) so
 * install's patches and binder are exercised.
 */
export function nfsClass(name: string, subDir: string): StorageClass {
  return {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: { name },
    provisioner: 'nfs.csi.k8s.io',
    parameters: { server: KIND_BYO_NFS_SERVER, share: KIND_BYO_NFS_SHARE, subDir },
    reclaimPolicy: 'Delete',
    volumeBindingMode: 'Immediate',
    mountOptions: ['nfsvers=4.1', 'hard'],
  }
}
