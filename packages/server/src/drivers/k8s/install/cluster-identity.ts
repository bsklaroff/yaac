/**
 * Which cluster an install is in, and the refusal every host-side verb
 * that touches the cluster makes when the kubeconfig now points at another.
 *
 * Every cluster call uses the kubeconfig's current context, and anyone
 * with a cloud install very likely has other contexts too: a `yaac server
 * restart` from a shell pointed at a work cluster would roll nothing of
 * this install's, and a `yaac cluster install` there would converge a
 * cluster that is not its own. So install records the cluster it installed
 * into (`server.json`'s `clusterUid`: the `kube-system` namespace's uid),
 * and `cluster install|check` and `server start|stop|restart|logs` compare
 * it with the current context's cluster — a refusal rather than pinning,
 * so nothing has to thread `--context` through the substrate. `cluster
 * delete` is not guarded: byo refuses it outright, and kind deletes its
 * cluster by name, never through the current context.
 *
 * The uid, not the context's name: names are local labels that collide
 * across kubeconfigs (`default`, `kubernetes-admin@kubernetes`), so a
 * `KUBECONFIG=` switch to a same-named context, or a context edited to
 * point elsewhere, would pass a name check. The name is recorded only for
 * the refusal's `use-context` hint.
 */
import { execFileAsync, kubectlErrorSummary } from '#drivers/k8s/substrate'
import { readServerConfig, type InstallRecord } from '@yaac/shared/server-config'

type Run = (file: string, args: string[]) => Promise<{ stdout: string }>

/** Where the current context points: its name and its cluster's uid. */
export interface CurrentCluster {
  context?: string
  uid?: string
  /** Why `uid` could not be read, when it could not. */
  unreadable?: string
}

/** The kubeconfig's current context, or undefined when it names none. */
export async function currentKubeContext(run: Run = execFileAsync): Promise<string | undefined> {
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
    const uid = (await run('kubectl', [
      'get', 'namespace', 'kube-system', '--request-timeout=10s', '-o', 'jsonpath={.metadata.uid}',
    ])).stdout.trim()
    return uid ? { context, uid } : { context, unreadable: 'it has no uid' }
  } catch (err) {
    return { context, unreadable: kubectlErrorSummary(err) }
  }
}

/**
 * The refusal for a current cluster that is not the recorded one, or null.
 * A record with no cluster predates it and goes unchecked
 * (docs/legacy-compat-shims.md). A current cluster that cannot be
 * identified is refused rather than let through: on a shared work cluster
 * with namespace-scoped RBAC, reading `kube-system` is Forbidden, and that
 * is exactly a cluster that is not the install's — on the install's own,
 * the read fails only when the apiserver does, which the refusal then says.
 */
export function clusterRefusal(recorded: InstallRecord, current: CurrentCluster): string | null {
  if (!recorded.clusterUid || recorded.clusterUid === current.uid) return null
  if (!current.uid && current.context && current.context === recorded.kubeContext) {
    // kubectl points through the context the install was made through, so
    // the likely story is a cluster that is down, not one somewhere else.
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
 * The CLI's form: this data dir's recorded cluster against the current
 * one, as a message to print, or null when nothing objects.
 */
export async function foreignClusterRefusal(): Promise<string | null> {
  const recorded = await readServerConfig()
  if (!recorded?.clusterUid) return null
  return clusterRefusal(recorded, await currentCluster())
}
