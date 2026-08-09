import { BatchV1Api, CoreV1Api, KubeConfig } from '@kubernetes/client-node'

/**
 * Lazy singletons for the typed API-server client (reads/watches only —
 * writes and exec stay on kubectl, see docs/event-driven-reconcile.md).
 * `loadFromDefault()` resolves the same kubeconfig kubectl does (KUBECONFIG
 * env included), so the client and the kubectl paths always talk to the
 * same cluster — including nested yaac, where the default context points at
 * the worktree's vcluster apiserver.
 */
let kubeConfig: KubeConfig | null = null
let coreApi: CoreV1Api | null = null
let batchApi: BatchV1Api | null = null

export function getKubeConfig(): KubeConfig {
  if (!kubeConfig) {
    kubeConfig = new KubeConfig()
    kubeConfig.loadFromDefault()
  }
  return kubeConfig
}

export function getCoreApi(): CoreV1Api {
  return (coreApi ??= getKubeConfig().makeApiClient(CoreV1Api))
}

export function getBatchApi(): BatchV1Api {
  return (batchApi ??= getKubeConfig().makeApiClient(BatchV1Api))
}

/** Drop the memoized config and clients (tests only). */
export function _resetK8sClientForTests(): void {
  kubeConfig = null
  coreApi = null
  batchApi = null
}
