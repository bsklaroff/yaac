// Public interface of the k8s substrate: the low-level cluster primitives
// the other `#drivers/k8s` folders use (run kubectl, name a Job, list pods,
// exec, open a stream, wait for readiness), plus the proxy datapath's names
// and ports. Nothing here makes decisions about workspaces, images or
// projects.
//
// Each name exported here needs a unit test in
// packages/server/test/drivers/k8s/substrate/. The client-node API handles
// (client.ts) and the informer registry (informer-cache.ts) are internal;
// they are covered through the cluster cache and the pod-readiness wait.

export { ClusterCache, getActiveClusterCache, setActiveClusterCache } from './cluster-cache'
export type { WorkspaceDeltaSource } from './cluster-cache'
export { containerExec } from './exec'
export {
  GVISOR_INSTALLER_READY_FILE,
  GVISOR_NODE_LABEL,
  gvisorNodeLabels,
  RUNTIME_CLASS_GVISOR,
  RUNTIME_CLASS_GVISOR_NESTED,
  buildRuntimeClassManifests,
  gvisorInstallScript,
  gvisorInstallerHostMounts,
  runtimeClassSpec,
} from './gvisor'
export { NODE_TASKSMAX_LIVE, NODE_TUNING_SYSCTLS } from './node-tuning'
export {
  dataDirHash,
  ensureKubernetes,
  execFileAsync,
  isKubectlAbsentError,
  k8sNamespace,
  kubectlApply,
  kubectlErrorSummary,
  kubectlGetJson,
  kubectlWithRetry,
} from './kubectl'
export {
  nodeLocalDirsOf,
  nodeLocalHostPath,
  nodeLocalNodePath,
  resolveMountSource,
} from './mount-sources'
export { k8sWorkspacePaths } from './workspace-paths'
export { invalidatePortForward, resolvePortForward } from './port-forward'
export {
  CA_BUNDLE_KEY,
  CA_CONFIGMAP_KEY,
  CA_CONFIGMAP_NAME,
  NESTED_ENGINE_CAPS,
  NESTED_GRAPHROOT_PATH,
  NESTED_GRAPHROOT_VOLUME,
  SSH_AGENT_SOCKET_PATH,
  PRE_STOP_GRACE_SECONDS,
  buildPodJobManifest,
  sentryTmpfsAnnotations,
  installSecurityContext,
  processIdentity,
} from './pod-spec'
export type { InstallIdentity, PodMount } from './pod-spec'
export {
  PRIORITY_CLASS_BUILDER,
  PRIORITY_CLASS_INFRA,
  buildPriorityClassManifests,
  ensurePriorityClasses,
} from './priority-classes'
export { waitForJobPodReady } from './pod-wait'
export { PRIVILEGED_PSS_LABELS } from './pss'
export {
  GLOBAL_CLAIM_NAME,
  LABEL_CLAIM,
  LABEL_INSTALL_ID,
  LABEL_INSTALL_NAMESPACE,
  POD_GLOBAL_ROOT,
  POD_NODE_LOCAL_ROOT,
  POD_SERVER_LOCAL_ROOT,
  SERVER_LOCAL_CLAIM_NAME,
} from './storage-constants'
export {
  LABEL_DATA_DIR_HASH,
  LABEL_NESTED,
  LABEL_PREWARMED,
  LABEL_PROJECT,
  LABEL_PROJECT_ID,
  LABEL_WORKSPACE_ID,
  LABEL_MODE,
  LABEL_TOOL,
  findWorkspacePod,
  isNested,
  isPrewarmed,
  listWorkspaceJobs,
  listWorkspacePods,
  runPodToCompletion,
  workspaceIdFromJobName,
  workspaceJobName,
  workspaceIdLabels,
  workspacePodSelector,
} from './pods'
export type { PodInfo } from './pods'
export {
  BUILDER_ROLE_GUARD_NAME,
  DNS_STUB_PORT,
  EGRESS_WORLD_DENY_NAME,
  LABEL_PROXY_INPUT,
  LABEL_PROXY_OUTPUT,
  LABEL_ROLE,
  NETD_APP_NAME,
  NETD_LISTENER_PORT_BASE,
  NETD_LISTENER_PORT_END,
  NETD_LISTENER_SLOTS,
  NETD_SA_NAME,
  LABEL_NPM_CACHE,
  NPM_CACHE_APP_NAME,
  NPM_CACHE_PORT,
  POD_STREAM_PORT,
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  PROXY_CA_SECRET_NAME,
  PROXY_CREDENTIALS_SECRET_NAME,
  PROXY_EGRESS_NP_NAME,
  PROXY_INGRESS_NP_NAME,
  PROXY_PORT,
  PROXY_PROJECT_SECRETS_PREFIX,
  PROXY_REFRESHED_SECRET_NAME,
  PROXY_REGISTRATION_PREFIX,
  PROXY_SA_NAME,
  PROXY_STATE_CONFIGMAP_NAME,
  RELAY_PORT,
  ROLE_BUILDER,
  SERVER_APP_NAME,
  SERVER_FRONT_APP_NAME,
  SERVER_FRONT_INGRESS_NP_NAME,
  SERVER_FRONT_PORT,
  SERVER_INGRESS_NP_NAME,
  SERVER_MAMA_PORT,
  SERVER_MAMA_SERVICE_NAME,
  SERVER_POD_PORT,
  SERVER_SA_NAME,
  TAILSCALE_OPERATOR_NAMESPACE,
  TAILSCALE_PARENT_NAMESPACE_LABEL,
  TAILSCALE_PARENT_RESOURCE_LABEL,
  WORKSPACE_EGRESS_NP_NAME,
  WORKSPACE_INGRESS_LOCK_NP_NAME,
  SSH_AGENT_PORT,
  SSH_TUNNEL_SENTINEL,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_TUNNEL_PORT,
  TUNNEL_INGRESS_PORT,
  proxyServiceHost,
} from './proxy-constants'
export {
  RelayExecError,
  bootStreamd,
  dialCtrlStream,
  dialPtyStream,
  relayDial,
  podExec,
  podStreamToken,
  waitForStreamd,
} from './stream-relay'
export { formatTaint, untoleratedTaints } from './taints'
export type { NodeTaint, PodToleration } from './taints'
export { createTickSnapshot } from './tick-snapshot'
