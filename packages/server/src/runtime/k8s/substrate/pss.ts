/**
 * Pod Security Standard labels for the namespaces yaac owns.
 *
 * PSS is namespace-scoped and has no per-workload granularity, so the level
 * a namespace declares must admit the most privileged pod in it. yaac's are
 * `privileged`, and every one of them needs to be:
 *
 *  - the install namespace runs **netd** (`hostNetwork` plus
 *    `NET_ADMIN`/`NET_RAW`, each of which alone exceeds `baseline`) and
 *    worktree pods with capabilities `baseline` forbids;
 *  - the registry namespace runs the node-write pods that hostPath-mount a
 *    node's `certs.d`;
 *  - a vcluster namespace hosts synced tenant pods, whose shape is decided
 *    by the vcluster's own admission guard, not by ours.
 *
 * These are labels on namespaces yaac creates, so they grant nothing
 * cluster-wide and relax nothing that was ever enforced on a cluster yaac
 * built (kind enforces no PSS by default). What they buy is a cluster yaac
 * ADOPTS: a cluster-wide `baseline`/`restricted` default is inherited by
 * every new namespace, and without declaring the level yaac's own pods are
 * rejected at admission — netd's DaemonSet creates no pod at all, so no node
 * gets a redirect and no worktree gets egress.
 *
 * Declared here rather than at each call site so the three namespaces
 * cannot drift, and so "which yaac namespaces are privileged, and why" has
 * one answer.
 *
 * One consequence worth naming: labelling the vcluster namespaces means a
 * host PSS default no longer backstops synced tenant pods anywhere, so the
 * vcluster's own synced-pod ValidatingAdmissionPolicy is the sole control
 * on their shape. That matches the design — PSS could never express what
 * that guard does, and relying on it would have been accidental defence —
 * but it does raise that guard's criticality.
 */
export const PRIVILEGED_PSS_LABELS: Readonly<Record<string, string>> = {
  'pod-security.kubernetes.io/enforce': 'privileged',
  'pod-security.kubernetes.io/audit': 'privileged',
  'pod-security.kubernetes.io/warn': 'privileged',
}
