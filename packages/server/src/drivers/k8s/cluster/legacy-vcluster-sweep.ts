import fs from 'node:fs/promises'
import path from 'node:path'
import { dataDirHash, k8sNamespace, kubectlWithRetry } from '#drivers/k8s/substrate'
import { projectWorktreeStateRoots, projectsRoots } from '@yaac/shared/project-paths'
import { serverLog } from '#log'

/**
 * Collect what a pre-removal yaac left behind: the per-worktree virtual
 * clusters, their wake activator, and the redirect-claim documents that
 * steered a nested install's egress.
 *
 * Every name and label here is copied from the retired vcluster stack
 * rather than imported, because there is nothing left to import them from
 * — this module is the last place in the tree that knows the vocabulary.
 * Deleted objects, never created ones: the sweep converges an upgrading
 * install and then no-ops forever (docs/legacy-compat-shims.md).
 *
 * Install-scoped by the data-dir-hash label yaac stamped on every vcluster
 * object, so a second install's vclusters on a shared cluster are left
 * strictly alone. Best-effort throughout — a cluster this cannot reach is
 * swept on the next server start.
 */

/** Ownership + install-scope labels the retired stack stamped. */
const LABEL_VCLUSTER = 'yaac.vcluster'
const LABEL_VCLUSTER_DATA_DIR_HASH = 'yaac.vcluster-data-dir-hash'
/** The wake activator's objects, all named after its app. */
const ACTIVATOR_APP_NAME = 'yaac-vc-activator'
/** Where the server republished each inner install's validated claims. */
const REDIRECT_CLAIMS_CM_NAME = 'yaac-redirect-claims'
/** Per-worktree dirs the retired stack kept under a worktree's state dir. */
const WORKTREE_SUBDIRS = ['vcluster', 'nested-yaac'] as const

/** Every vcluster object of THIS install, whatever kind it is. */
function installScope(): string {
  return `${LABEL_VCLUSTER},${LABEL_VCLUSTER_DATA_DIR_HASH}=${dataDirHash()}`
}

async function sweep(what: string, args: string[]): Promise<void> {
  try {
    await kubectlWithRetry(args, { maxAttempts: 2, timeout: 60_000 })
  } catch (err) {
    serverLog(`[server] legacy vcluster sweep (${what}): ${(err as Error).message}`)
  }
}

/**
 * Remove every trace of the retired virtualCluster feature.
 *
 * Fired detached at driver attach, beside the orphan registry GC: an
 * install upgrading over live vcluster worktrees would otherwise keep
 * whole control planes running that nothing deletes any more, since the
 * teardown path and orphan reconcile that used to collect them are gone.
 * The worktrees themselves are untouched — they lose their in-worktree
 * cluster and keep running as ordinary worktrees.
 */
export async function sweepLegacyVclusterState(): Promise<void> {
  const ns = k8sNamespace()

  // The namespaces take the control planes, synced pods, per-vcluster
  // policies, kubeconfig secrets and sleep EndpointSlices with them.
  // --wait=false: a namespace delete is a background finalizer walk, and
  // nothing here needs to see it finish.
  await sweep('namespaces', [
    'delete', 'namespace', '-l', installScope(), '--ignore-not-found', '--wait=false',
  ])
  await sweep('cluster-scoped', [
    'delete',
    'clusterroles,clusterrolebindings,validatingadmissionpolicies,'
    + 'validatingadmissionpolicybindings',
    '-l', installScope(), '--ignore-not-found', '--wait=false',
  ])
  // Per-worktree holes in the install namespace's policy set.
  await sweep('networkpolicies', [
    'delete', 'networkpolicy', '-n', ns,
    '-l', installScope(), '--ignore-not-found', '--wait=false',
  ])
  // The activator and the claims document are singletons named after
  // themselves — the retired stack stamped them with `app:` alone, so there
  // is no install label to select on and they go by name. That makes these
  // two the one exception to the sibling-install guarantee above: installs
  // sharing a namespace share these objects, so a staggered upgrade takes a
  // still-old sibling's waker with it. Self-healing on the sibling's side
  // (its own ensure re-applies both on the next vcluster create) and noted
  // in docs/legacy-compat-shims.md.
  await sweep('activator', [
    'delete',
    'deployment,serviceaccount,networkpolicy,role,rolebinding',
    ACTIVATOR_APP_NAME, '-n', ns, '--ignore-not-found', '--wait=false',
  ])
  await sweep('redirect-claims', [
    'delete', 'configmap', REDIRECT_CLAIMS_CM_NAME, '-n', ns,
    '--ignore-not-found', '--wait=false',
  ])

  // On disk: the kubeconfig dir the pod mounted at ~/.kube, and the inner
  // install's whole data dir. Both hang off a worktree's own state dir, so
  // a worktree that never had a vcluster simply has neither.
  const slugSets = await Promise.all(
    projectsRoots().map((root) => fs.readdir(root).catch((): string[] => [])),
  )
  for (const slug of new Set(slugSets.flat())) {
    for (const root of projectWorktreeStateRoots(slug)) {
      let worktreeIds: string[] = []
      try {
        worktreeIds = await fs.readdir(root)
      } catch { continue /* no sessions dir → nothing to sweep */ }
      for (const worktreeId of worktreeIds) {
        for (const sub of WORKTREE_SUBDIRS) {
          const dir = path.join(root, worktreeId, sub)
          try {
            await fs.rm(dir, { recursive: true, force: true })
          } catch (err) {
            serverLog(`[server] legacy vcluster sweep (${dir}): ${(err as Error).message}`)
          }
        }
      }
    }
  }
}
