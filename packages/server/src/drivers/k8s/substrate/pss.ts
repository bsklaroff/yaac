/**
 * Pod Security Standard labels for the namespaces yaac creates. PSS applies
 * per namespace, so the level must admit the most privileged pod in it:
 *
 *  - the install namespace runs netd (`hostNetwork`, `NET_ADMIN`/`NET_RAW`)
 *    and workspace pods with capabilities `baseline` forbids;
 *  - the registry namespace runs pods that hostPath-mount a node's
 *    `certs.d`.
 *
 * kind enforces no PSS by default, but an adopted cluster may default new
 * namespaces to `baseline` or `restricted`, which would reject these pods
 * at admission.
 */
export const PRIVILEGED_PSS_LABELS: Readonly<Record<string, string>> = {
  'pod-security.kubernetes.io/enforce': 'privileged',
  'pod-security.kubernetes.io/audit': 'privileged',
  'pod-security.kubernetes.io/warn': 'privileged',
}
