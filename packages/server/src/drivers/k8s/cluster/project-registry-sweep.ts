import { LABEL_INSTALL_ID, deleteObjects, installId, k8sNamespace } from '#drivers/k8s/substrate'

/**
 * Deletes the per-project push registries an older server created for
 * nested-container workspaces: each one's Deployment, Service, policies,
 * one-shot pods and PVC (docs/legacy-compat-shims.md "Project registries").
 * Scoped to this install. A pass that finds nothing costs one list per kind.
 */
export async function sweepProjectRegistries(): Promise<void> {
  const opts = { namespace: k8sNamespace(), labelSelector: `app=yaac-registry,${LABEL_INSTALL_ID}=${installId()}` }
  for (const [apiVersion, kind] of [
    ['apps/v1', 'Deployment'],
    ['v1', 'Service'],
    ['networking.k8s.io/v1', 'NetworkPolicy'],
    ['v1', 'Pod'],
    // Last: its finalizer holds it until the pods mounting it are gone.
    ['v1', 'PersistentVolumeClaim'],
  ] as const) await deleteObjects(apiVersion, kind, opts)
}
