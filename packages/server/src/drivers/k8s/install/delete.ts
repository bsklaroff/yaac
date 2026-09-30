import { confirmDefault, kindEnv } from './install'
import { ClusterDeleteError } from './arg-guards'
import {
  BUILDER_ROLE_GUARD_NAME,
  LABEL_INSTALL_ID,
  LABEL_INSTALL_NAMESPACE,
  RUNTIME_CLASS_GVISOR,
  RUNTIME_CLASS_GVISOR_NESTED,
  buildPriorityClassManifests,
  execFileAsync,
  gvisorNodeLabels,
  k8sNamespace,
} from '#drivers/k8s/substrate'
import { REGISTRY_GRANT_NAMESPACE, REGISTRY_NAMESPACE } from '#drivers/k8s/container'
import { readServerConfig } from '@yaac/shared/server-config'
import { env } from '@yaac/shared/env'

/**
 * `yaac cluster delete`: delete the local kind cluster that `yaac cluster
 * install` created. Every yaac workload and its node-local storage
 * (including registry image blobs) lives inside the cluster, so one
 * `kind delete` removes it all. The yaac data dir (projects, workspaces) is
 * untouched, and a later `yaac cluster install` recreates the cluster and
 * re-pushes the images.
 */

// Defined in arg-guards.ts, which is cheap to import.
export { ClusterDeleteError }

export interface ClusterDeleteOptions {
  /** Skip the interactive confirmation (for scripts / non-interactive use). */
  yes?: boolean
}

/**
 * Names of the kind clusters the podman provider can see. Throws
 * ClusterDeleteError when kind cannot be queried (usually kind missing or
 * podman stopped). Lines with whitespace, such as "No kind clusters
 * found.", are dropped: cluster names never contain any.
 */
async function listKindClusters(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('kind', ['get', 'clusters'], { env: kindEnv() })
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/\s/.test(l))
  } catch (err) {
    const detail = ((err as { stderr?: string })?.stderr ?? '').trim()
      || (err instanceof Error ? err.message : String(err))
    throw new ClusterDeleteError(
      'Could not list kind clusters (is kind installed and podman running?):\n'
      + `  ${detail.split('\n')[0]}`,
    )
  }
}

/**
 * Delete the kind cluster, confirming first unless `yes`. Refuses on a byo
 * install; an absent cluster is a no-op. Throws ClusterDeleteError with a
 * user-actionable message when a step cannot proceed.
 */
export async function runClusterDelete(
  opts: ClusterDeleteOptions = {},
): Promise<void> {
  const recorded = await readServerConfig()
  if (recorded?.byo) throw new ClusterDeleteError(byoUninstall(recorded.installId))

  const cluster = env.kindCluster
  const exists = (await listKindClusters()).includes(cluster)

  if (!opts.yes) {
    const proceed = await confirmDefault(
      `This deletes the kind cluster "${cluster}", including the in-cluster `
      + 'image registry and every image pushed to it. Any running sessions '
      + 'stop, but their on-disk state and workspaces are kept. Continue?',
    )
    if (!proceed) {
      console.log('Aborted — nothing was deleted.')
      return
    }
  }

  if (exists) {
    console.log(`Deleting kind cluster "${cluster}"...`)
    await execFileAsync('kind', ['delete', 'cluster', '--name', cluster], { env: kindEnv() })
  } else {
    console.log(`No kind cluster "${cluster}" to delete.`)
  }

  console.log(
    '\nDone. Sessions and workspaces on disk are untouched — run '
    + '`yaac cluster install` to recreate the cluster when you need it.',
  )
}

/**
 * Manual uninstall steps printed for a byo install, whose cluster yaac
 * does not delete: this install's namespaces and cluster-scoped objects,
 * then the objects all installs on the cluster share, and last the two
 * `Retain` volumes, selected by install id.
 */
function byoUninstall(installId: string | undefined): string {
  const ns = k8sNamespace()
  const namespaces = [...new Set([ns, REGISTRY_NAMESPACE, REGISTRY_GRANT_NAMESPACE])].join(' ')
  const priorityClasses = (buildPriorityClassManifests() as Array<{ metadata: { name: string } }>)
    .map((c) => c.metadata.name).join(' ')
  const nodeLabels = Object.keys(gvisorNodeLabels()).map((l) => `${l}-`).join(' ')
  return [
    'This is a --byo install: the cluster is not yaac\'s to delete, so nothing was.',
    'To uninstall yaac from it, first this install\'s own objects (the namespaces hold the server,',
    'the registry and the registry\'s signing key):',
    `  kubectl delete namespace ${namespaces}`,
    `  kubectl delete clusterrole,clusterrolebinding -l ${LABEL_INSTALL_NAMESPACE}=${ns}`,
    'Then, only if no other yaac install uses this cluster, what every install on it shares:',
    `  kubectl delete runtimeclass ${RUNTIME_CLASS_GVISOR} ${RUNTIME_CLASS_GVISOR_NESTED}`,
    `  kubectl delete priorityclass ${priorityClasses}`,
    `  kubectl delete validatingadmissionpolicy,validatingadmissionpolicybinding ${BUILDER_ROLE_GUARD_NAME}`,
    `  kubectl label nodes --all ${nodeLabels}`,
    'The gVisor runtime the installer put on each node stays in its containerd config until the node',
    'is replaced. The two storage volumes are Retain, so the data survives all of the above; remove',
    'them deliberately, and then their bytes on the storage backend:',
    installId
      ? `  kubectl delete pv -l ${LABEL_INSTALL_ID}=${installId}`
      : '  (this data dir records no install id: find the volumes with `kubectl get pv -l yaac.claim`)',
  ].join('\n')
}
