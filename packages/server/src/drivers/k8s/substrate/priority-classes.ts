import { kubectlApply } from './kubectl'

/**
 * Scheduling priority tiers for yaac pods. Infra pods (the egress proxy and
 * per-project registries) serve every workspace, so they outrank
 * workspaces and node-pressure eviction picks a workspace first. Builders
 * sit between, but may not preempt a workspace. netd uses
 * `system-node-critical` because it is node infrastructure, like
 * kube-proxy.
 */

/** Long-lived trusted infrastructure: the proxy and per-project registries. */
export const PRIORITY_CLASS_INFRA = 'yaac-infra'
/**
 * Ephemeral builder pods. They outrank workspaces under node pressure but
 * never preempt one to start.
 */
export const PRIORITY_CLASS_BUILDER = 'yaac-builder'
/** Workspace pods, evicted first. */
export const PRIORITY_CLASS_WORKSPACE = 'yaac-workspace'

/**
 * Priority values, well below Kubernetes' reserved `system-*` range and
 * spaced apart for future tiers. Workspaces sit above the default (0), so
 * unrelated pods on the cluster are evicted before a live workspace.
 */
export const PRIORITY_VALUE_INFRA = 1_000_000
export const PRIORITY_VALUE_BUILDER = 100_000
export const PRIORITY_VALUE_WORKSPACE = 1_000

/** Priority class for workspace pods. */
export function priorityClassSpec(): { priorityClassName?: string } {
  return { priorityClassName: PRIORITY_CLASS_WORKSPACE }
}

/**
 * The PriorityClasses yaac pods use. They are cluster-scoped and shared by
 * every install on the cluster (including e2e namespaces), so they carry no
 * install labels and teardown never deletes them.
 *
 * Workspaces and builders use `preemptionPolicy: Never`. For workspaces
 * this stops a pending one from preempting unrelated priority-0 pods. For
 * builders it stops a routine build from preempting running workspaces,
 * which are then gone for good (`backoffLimit: 0`) with a misleading
 * `pod-stopped` cause. Infra keeps the default, so when the proxy has
 * nowhere to run, one workspace is preempted to make room.
 */
export function buildPriorityClassManifests(): Array<Record<string, unknown>> {
  return [
    {
      name: PRIORITY_CLASS_INFRA,
      value: PRIORITY_VALUE_INFRA,
      description: 'yaac infrastructure (proxy, registries) — outranks workspaces.',
    },
    {
      name: PRIORITY_CLASS_BUILDER,
      value: PRIORITY_VALUE_BUILDER,
      preemptionPolicy: 'Never',
      description: 'yaac image builders — outrank workspaces, never displace one.',
    },
    {
      name: PRIORITY_CLASS_WORKSPACE,
      value: PRIORITY_VALUE_WORKSPACE,
      preemptionPolicy: 'Never',
      description: 'yaac workspace pods — evicted before yaac infrastructure.',
    },
  ].map(({ name, ...spec }) => ({
    apiVersion: 'scheduling.k8s.io/v1',
    kind: 'PriorityClass',
    metadata: { name },
    globalDefault: false,
    ...spec,
  }))
}

/**
 * Apply the PriorityClasses. Runs on every server start as well as from
 * `yaac cluster install`, so an older cluster gets them on upgrade. They
 * must exist before any pod naming them: the apiserver rejects such a pod
 * and its Job hangs instead of failing.
 */
export async function ensurePriorityClasses(): Promise<void> {
  for (const manifest of buildPriorityClassManifests()) await kubectlApply(manifest)
  // The old `yaac-session` and `yaac-worktree` classes are not deleted:
  // another install on the cluster running older code may still use them.
}
