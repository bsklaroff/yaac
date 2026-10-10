/**
 * Refuse host-side cluster commands when the kubeconfig's current context
 * points at a different cluster than the one this install is in.
 *
 * Every cluster call uses the current context, so a shell pointed at
 * another cluster would otherwise act on the wrong one. Install records the
 * `kube-system` namespace's uid as `install.json`'s `clusterUid`, and
 * `cluster install|check|start|stop|restart|logs` compare it
 * with the current cluster. `cluster delete` is not guarded: byo refuses
 * it, and kind deletes its cluster by name.
 *
 * The uid is compared rather than the context name, since names like
 * `default` collide across kubeconfigs. The name is recorded only for the
 * `use-context` hint.
 */
import { execFileAsync, k8sErrorSummary, readObject } from '#drivers/k8s/substrate'
import { readInstallRecord, type InstallRecord } from '@yaac/shared/install-record'

type Run = (file: string, args: string[]) => Promise<{ stdout: string }>

/** Where the current context points: its name and its cluster's uid. */
export interface CurrentCluster {
  context?: string
  uid?: string
  /** Why `uid` could not be read, when it could not. */
  unreadable?: string
}

/**
 * The kubeconfig's current context, or undefined when it names none. A
 * question about the kubeconfig rather than the cluster, so it asks
 * kubectl, which resolves the kubeconfig as client-node does.
 */
async function currentKubeContext(run: Run = execFileAsync): Promise<string | undefined> {
  try {
    return (await run('kubectl', ['config', 'current-context'])).stdout.trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * The current context's name and cluster uid, each undefined when it
 * cannot be read, with the reason the uid could not be.
 */
export async function currentCluster(run: Run = execFileAsync): Promise<CurrentCluster> {
  const context = await currentKubeContext(run)
  try {
    const ns = await readObject<{ metadata?: { uid?: string } }>({
      apiVersion: 'v1', kind: 'Namespace', name: 'kube-system',
    })
    const uid = ns?.metadata?.uid
    return uid ? { context, uid } : { context, unreadable: ns ? 'it has no uid' : 'it does not exist' }
  } catch (err) {
    return { context, unreadable: k8sErrorSummary(err) }
  }
}

/**
 * The refusal message when the current cluster is not the recorded one, or
 * null. A record without `clusterUid` (before the first install) is not
 * checked. A cluster whose uid cannot be read is
 * refused too: a namespace-scoped user on some other cluster cannot read
 * `kube-system`, while on the install's own cluster the read fails only
 * when the apiserver is down.
 */
export function clusterRefusal(recorded: InstallRecord, current: CurrentCluster): string | null {
  if (!recorded.clusterUid || recorded.clusterUid === current.uid) return null
  if (!current.uid && current.context && current.context === recorded.kubeContext) {
    // Same context as at install, so the cluster is most likely down.
    return `kubectl's current context "${current.context}" is the one this install was made through, but `
      + 'its cluster cannot be reached or identified (reading its kube-system namespace failed: '
      + `${current.unreadable ?? 'no answer'}). If the cluster is down, bring it back — on kind, `
      + '`yaac cluster install` restarts stopped nodes; otherwise fix its access, and try again.'
  }
  if (!current.uid) {
    return `This install is in ${recorded.kubeContext ? `the cluster of kube context "${recorded.kubeContext}"` : 'another cluster'}, `
      + `and the cluster kubectl's current context${current.context ? ` "${current.context}"` : ''} points at cannot be `
      + `identified (reading its kube-system namespace failed: ${current.unreadable ?? 'no answer'}). Point kubectl `
      + 'at the install\'s cluster, or fix its access, and try again'
      + (recorded.kubeContext && current.context !== recorded.kubeContext
        ? `:\n  kubectl config use-context ${recorded.kubeContext}`
        : '.')
  }
  const here = recorded.kubeContext ? `the cluster of kube context "${recorded.kubeContext}"` : 'another cluster'
  const now = current.context === recorded.kubeContext
    ? `kubectl's current context has the same name but is a different cluster (a KUBECONFIG `
      + 'switch, or a context edited to point elsewhere)'
    : `kubectl's current context${current.context ? ` "${current.context}"` : ''} is a different cluster`
  return `This install is in ${here}, and ${now} — every cluster call would go to the wrong `
    + 'cluster. Point kubectl back at the install\'s cluster first'
    + (recorded.kubeContext && current.context !== recorded.kubeContext
      ? `:\n  kubectl config use-context ${recorded.kubeContext}`
      : ` (its kube-system namespace has uid ${recorded.clusterUid}).`)
}

/**
 * `clusterRefusal` for this data dir's recorded k8s install, or null when
 * there is none. `yaac cluster install` records the cluster, so a k8s
 * record without one is refused until it runs.
 */
export async function foreignClusterRefusal(): Promise<string | null> {
  const recorded = await readInstallRecord()
  if (recorded?.driver !== 'k8s') return null
  if (!recorded.clusterUid) {
    return 'This install records no cluster to check kubectl against. Run `yaac cluster install`, '
      + 'which records it, and try again.'
  }
  return clusterRefusal(recorded, await currentCluster())
}
