import { kubectlApply } from './kubectl'

/**
 * The two-tier scheduling priority every yaac pod is stamped with.
 *
 * The split exists because the infra pods are shared fate: the egress proxy
 * is every session's DNS resolver and its only route to the world, and the
 * per-project registries are where session images come from. A full node
 * that evicts one of those takes down every session on it, while evicting
 * one session costs one session. So infra outranks sessions, and kubelet's
 * node-pressure eviction (which orders by QoS, then priority, then usage
 * over request) picks the cheap victim. Builders sit between the two —
 * above sessions, but forbidden from preempting one.
 *
 * The per-session vcluster control planes are the deliberate omission: they
 * come out of `helm template` (k8s/vcluster/values.yaml) and stamp nothing,
 * so they sit at 0, below sessions. That is the right way round — a control
 * plane is Deployment-managed and comes back, a session Job does not.
 *
 * netd is the exception and stays on `system-node-critical`: it is a
 * DaemonSet in the node's netns programming the redirect, so it is node
 * infrastructure in the same sense kube-proxy is.
 */

/** Long-lived trusted infrastructure: the proxy and per-project registries. */
export const PRIORITY_CLASS_INFRA = 'yaac-infra'
/**
 * Ephemeral builder pods. Between the two: a build a session is waiting on
 * should outlive that session under node pressure, but must never displace
 * one to start (see the manifests below).
 *
 * Stamped unconditionally, unlike the session tier, and that is safe only
 * because a NESTED yaac never creates one — build-engine routes every build
 * to host-podman when `env.nested`. If that routing ever changes, this class
 * needs the same inner-skip treatment as sessions (priorityClassSpec): it
 * declares `preemptionPolicy`, which is exactly what the vcluster syncer
 * copies to the host and the host then rejects.
 */
export const PRIORITY_CLASS_BUILDER = 'yaac-builder'
/** Session pods — the tier that gets evicted first. */
export const PRIORITY_CLASS_SESSION = 'yaac-session'

/**
 * Priority values. All sit far below the 1e9 floor kubernetes reserves for
 * its own `system-*` classes, and far apart from each other so another tier
 * can slot in between without renumbering. Sessions are above the unstamped
 * default (0) so anything else sharing the cluster ranks below a live
 * session under node pressure.
 */
export const PRIORITY_VALUE_INFRA = 1_000_000
export const PRIORITY_VALUE_BUILDER = 100_000
export const PRIORITY_VALUE_SESSION = 1_000

/**
 * THE priority policy for SESSION-TIER pods. An `inner` pod — one created
 * by a nested yaac against its vcluster — stamps NOTHING, for the same
 * shape of reason runtimeClassSpec skips the RuntimeClass there, and one
 * hard constraint: the syncer DROPS the class name on the way to the host
 * but COPIES `preemptionPolicy`, and the host's priority admission plugin
 * then rejects the pod ("the string value of PreemptionPolicy (Never) must
 * not be provided in pod spec") — a synced pod that never lands is a
 * session that never starts. Nothing is lost by skipping it: the host
 * scheduler places synced pods and never sees a vcluster's classes anyway.
 */
export function priorityClassSpec(opts: { inner?: boolean }): { priorityClassName?: string } {
  if (opts.inner) return {}
  return { priorityClassName: PRIORITY_CLASS_SESSION }
}

/**
 * The PriorityClasses every yaac manifest builder stamps. Cluster scoped and
 * install-independent (coexisting installs — the real one plus per-run e2e
 * namespaces — share them), so they carry no install labels and no teardown
 * deletes them; same treatment as the RuntimeClasses.
 *
 * Sessions and builders declare `preemptionPolicy: Never`. Preemption only
 * ever targets STRICTLY lower priority, so for sessions this is not about
 * evicting each other (equal priority — they never could); it stops a
 * pending session from killing the unstamped priority-0 pods it shares the
 * cluster with, which include the vcluster control planes other sessions
 * depend on. For builders it is the load-bearing one: a builder outranks
 * every session, so without it a routine image build could preempt running
 * sessions until its request fits — and a preempted session pod is deleted
 * for good (`backoffLimit: 0`), anonymously (preemption is not `Evicted`,
 * so the death cause reads `pod-stopped`). A build that waits is the same
 * trade sessions already make for themselves.
 *
 * Infra alone keeps the default (PreemptLowerPriority): that is the whole
 * point of the split — when the proxy has nowhere to run, one session dies
 * so the rest keep their network. That default is also load-bearing for
 * NESTED installs, and must stay: an inner yaac's proxy/registry pods are
 * stamped like any other and synced to the host, where they survive
 * admission only because the syncer-copied policy matches the
 * PreemptLowerPriority the host computes for a pod whose class name the
 * syncer dropped. Adding an explicit `preemptionPolicy` to the infra class
 * would break every nested infra pod the way it broke sessions (see
 * priorityClassSpec).
 */
export function buildPriorityClassManifests(): Array<Record<string, unknown>> {
  return [
    {
      name: PRIORITY_CLASS_INFRA,
      value: PRIORITY_VALUE_INFRA,
      description: 'yaac infrastructure (proxy, registries) — outranks sessions.',
    },
    {
      name: PRIORITY_CLASS_BUILDER,
      value: PRIORITY_VALUE_BUILDER,
      preemptionPolicy: 'Never',
      description: 'yaac image builders — outrank sessions, never displace one.',
    },
    {
      name: PRIORITY_CLASS_SESSION,
      value: PRIORITY_VALUE_SESSION,
      preemptionPolicy: 'Never',
      description: 'yaac session pods — evicted before yaac infrastructure.',
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
 * Install the PriorityClasses. Idempotent, and cheap enough to run on every
 * server start: the classes must exist BEFORE any pod naming them is
 * created (the apiserver rejects a pod whose class is missing, and a Job
 * whose pod is rejected hangs instead of failing cleanly), and running it at
 * boot as well as from `yaac cluster setup` is how a cluster installed by an
 * older yaac picks them up on upgrade.
 */
export async function ensurePriorityClasses(): Promise<void> {
  for (const manifest of buildPriorityClassManifests()) await kubectlApply(manifest)
}
