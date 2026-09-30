/**
 * Claim names and pod paths shared by every manifest that mounts a storage
 * tier. Has no imports (like proxy-constants.ts), so a manifest builder can
 * name a claim without pulling in the path resolver.
 *
 * The three tiers (the legend in packages/shared/src/paths.ts) reach the
 * cluster as two claims and one node path (docs/server-in-cluster.md
 * "Storage is two claims"):
 *
 *  - GLOBAL is the RWX claim `yaac-global`. The server pod mounts it whole
 *    at `POD_GLOBAL_ROOT`; every workspace pod mounts subPaths of it.
 *  - SERVER-LOCAL is the RWO claim `yaac-server-local`, mounted by the
 *    server pod alone at `POD_SERVER_LOCAL_ROOT`. No workspace pod may
 *    mount it, and the resolver refuses a path under it.
 *  - NODE-LOCAL is a hostPath on the node, `NODE_LOCAL_NODE_ROOT/<hash>`
 *    (hashed so two installs on one cluster — the real one and every e2e
 *    namespace — never share a node directory), mounted by the server pod
 *    at `POD_NODE_LOCAL_ROOT` and by workspace pods per directory.
 *
 * The pod paths carry no hash: a pod belongs to one install.
 */

export const GLOBAL_CLAIM_NAME = 'yaac-global'
export const SERVER_LOCAL_CLAIM_NAME = 'yaac-server-local'

export const POD_GLOBAL_ROOT = '/yaac/global'
export const POD_SERVER_LOCAL_ROOT = '/yaac/server-local'
export const POD_NODE_LOCAL_ROOT = '/yaac/node-local'

/** Parent of every install's node-local tree on a node; see `nodeLocalNodePath`. */
export const NODE_LOCAL_NODE_ROOT = '/var/lib/yaac/node'

/**
 * Label naming the install namespace on a cluster-scoped object (a
 * PersistentVolume, a ClusterRole). Such objects survive namespace
 * deletion, so the e2e sweep uses this label to find an interrupted run's
 * leftovers without touching the real install's.
 */
export const LABEL_INSTALL_NAMESPACE = 'yaac.install-namespace'
/**
 * Label naming which of the two claims a PersistentVolume backs. A
 * class-provisioned volume's name is chosen by the provisioner, so this
 * label plus the install id is how a later install finds a volume that
 * outlived its claim.
 */
export const LABEL_CLAIM = 'yaac.claim'
/**
 * Label carrying `server.json`'s `installId` on the server Deployment and
 * on every volume a byo install provisions. It identifies the install; the
 * data-dir hash only identifies the path it was installed from.
 */
export const LABEL_INSTALL_ID = 'yaac.install-id'
