/**
 * The storage vocabulary: the names and pod paths every manifest that
 * mounts a tier agrees on. Zero imports, like proxy-constants.ts, so a
 * builder can name a claim without pulling the resolver in.
 *
 * The three tiers (the legend in packages/shared/src/paths.ts) reach the
 * cluster as two claims and one node path (docs/server-in-cluster.md
 * "Storage is two claims"):
 *
 *  - GLOBAL is the RWX claim `yaac-global`. The server pod mounts it whole
 *    at `POD_GLOBAL_ROOT`; every worktree pod mounts subPaths of it.
 *  - SERVER-LOCAL is the RWO claim `yaac-server-local`, mounted by the
 *    server pod alone at `POD_SERVER_LOCAL_ROOT`. No worktree pod may
 *    mount it, and the resolver refuses a path under it.
 *  - NODE-LOCAL is a hostPath on the node, `NODE_LOCAL_NODE_ROOT/<hash>`
 *    (hashed so two installs on one cluster — the real one and every e2e
 *    namespace — never share a node directory), mounted by the server pod
 *    at `POD_NODE_LOCAL_ROOT` and by worktree pods per directory.
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
 * Label naming the install namespace on a CLUSTER-SCOPED object (a
 * PersistentVolume, a ClusterRole), which does not cascade when that
 * namespace is deleted — so the e2e sweep can find an interrupted run's
 * leftovers without matching the real install's.
 */
export const LABEL_INSTALL_NAMESPACE = 'yaac.install-namespace'
