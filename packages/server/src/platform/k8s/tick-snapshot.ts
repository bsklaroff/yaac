import { listSessionJobs, listSessionPods, type SessionJob, type SessionPod } from '#platform/k8s/pods'
import { listVclusterNamespaces, type VclusterNamespaceInfo } from '#features/cluster/vcluster'

/**
 * One background-loop tick's shared view of the cluster listings several
 * steps need. Each getter runs its kubectl list at most once per snapshot
 * (the loop creates a fresh one every tick) and is lazy — a listing no
 * step asks for is never fetched. Before this, four steps each ran their
 * own `kubectl get pods` (plus jobs and vcluster-namespace lists) every
 * 5s tick; the child-process churn was a measurable slice of steady-state
 * server CPU.
 *
 * A failed listing stays failed for the whole tick (every consumer sees
 * the same rejection) — steps already treat a listing failure as "skip
 * this tick", and the next tick's fresh snapshot retries.
 */
export interface TickSnapshot {
  pods(): Promise<SessionPod[]>
  jobs(): Promise<SessionJob[]>
  vclusters(): Promise<VclusterNamespaceInfo[]>
}

export function createTickSnapshot(): TickSnapshot {
  let pods: Promise<SessionPod[]> | null = null
  let jobs: Promise<SessionJob[]> | null = null
  let vclusters: Promise<VclusterNamespaceInfo[]> | null = null
  return {
    pods: () => (pods ??= listSessionPods()),
    jobs: () => (jobs ??= listSessionJobs()),
    vclusters: () => (vclusters ??= listVclusterNamespaces()),
  }
}
