// The public interface of the k8s substrate: the primitives every other
// folder under `#drivers/k8s` talks to the cluster with. Everything outside
// this directory imports `#drivers/k8s/substrate`; the SEALED_FOLDERS lint
// rule stops src from reaching past this file. Modules in here import each
// other by relative path, which is why they are unaffected by that rule.
//
// This is not a feature: nothing here decides anything about worktrees,
// images or projects. It is the vocabulary every feature uses to talk to the
// cluster — run a kubectl, name a Job, read the pods, exec into one, open a
// stream, wait for readiness — plus the datapath's names and ports, which
// have no imports at all. Being the driver's bottom rather than a layer of
// its own is what rule 1 of the runtime contract asks for: nothing above
// `runtime/` may name it.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/drivers/k8s/substrate/. Two modules are internal whole: the
// `@kubernetes/client-node` API handles, and the informer registry that
// wraps a watch in a keyed cache. Both are reached only through the cluster
// cache and the pod-readiness watch, which is where they are covered.

export { ClusterCache, getActiveClusterCache, setActiveClusterCache } from './cluster-cache'
export { VCLUSTER_DELTA_SOURCES } from './cluster-cache'
export type { DeltaSource, VclusterDeltaSource } from './cluster-cache'
export {
  anyWorktreeDirsExist,
  armDeferredClusterBoot,
  awaitDeferredClusterBoot,
  isDeferredClusterBootPending,
  triggerDeferredClusterBoot,
} from './deferred-boot'
export { containerExec } from './exec'
export { ExecTunnel } from './exec-tunnel'
export {
  GVISOR_INSTALLER_READY_FILE,
  GVISOR_NODE_LABEL,
  GVISOR_NODE_VERSION_LABEL,
  RUNTIME_CLASS_GVISOR,
  RUNTIME_CLASS_GVISOR_NESTED,
  buildRuntimeClassManifests,
  gvisorInstallScript,
  gvisorInstallerHostMounts,
  runtimeClassSpec,
} from './gvisor'
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
export { ensurePinnedBinary } from './pinned-binary'
export { k8sWorkspacePaths } from './workspace-paths'
export { invalidatePortForward, resolvePortForward } from './port-forward'
export type { ForwardAddr, PortForwardSpec } from './port-forward'
export {
  CA_BUNDLE_KEY,
  CA_CERT_PATH,
  CA_CONFIGMAP_KEY,
  CA_CONFIGMAP_NAME,
  NESTED_ENGINE_CAPS,
  NESTED_GRAPHROOT_PATH,
  NESTED_GRAPHROOT_VOLUME,
  SSH_AGENT_MOUNT,
  SSH_AGENT_SOCKET_PATH,
  buildPodJobManifest,
  graphrootMountAnnotations,
  podUid,
} from './pod-spec'
export type { HostPathType, MountSource, PodMount } from './pod-spec'
export {
  PRIORITY_CLASS_BUILDER,
  PRIORITY_CLASS_INFRA,
  buildPriorityClassManifests,
  ensurePriorityClasses,
} from './priority-classes'
export { waitForJobPodReady } from './pod-wait'
export { PRIVILEGED_PSS_LABELS } from './pss'
export {
  LABEL_DATA_DIR_HASH,
  LABEL_PREWARMED,
  LABEL_PROJECT,
  LABEL_WORKTREE_ID,
  LABEL_MODE,
  LABEL_TOOL,
  LABEL_VCLUSTER_MANAGED_BY,
  VCLUSTER_API_PORT,
  findWorktreePod,
  isPrewarmed,
  listWorktreeJobs,
  listWorktreePods,
  runPodToCompletion,
  worktreeIdFromJobName,
  worktreeJobName,
  worktreeIdLabels,
} from './pods'
export type { PodInfo } from './pods'
export {
  BUILDER_ROLE_GUARD_NAME,
  DNS_STUB_PORT,
  EGRESS_WORLD_DENY_NAME,
  INNER_PROXY_INGRESS_NP_NAME,
  INNER_WORKTREE_INGRESS_LOCK_NP_NAME,
  LABEL_ROLE,
  LABEL_VCLUSTER_NAMESPACE,
  NETD_APP_NAME,
  NETD_LISTENER_PORT_BASE,
  NETD_LISTENER_PORT_END,
  NETD_LISTENER_SLOTS,
  NETD_SA_NAME,
  OUTER_CA_CONFIGMAP_NAME,
  POD_STREAM_PORT,
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  PROXY_INGRESS_NP_NAME,
  PROXY_PORT,
  PROXY_SA_NAME,
  RELAY_PORT,
  ROLE_BUILDER,
  ROLE_INNER_PROXY,
  WORKTREE_EGRESS_NP_NAME,
  WORKTREE_INGRESS_LOCK_NP_NAME,
  SSH_AGENT_PORT,
  SSH_TUNNEL_SENTINEL,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_TUNNEL_PORT,
  TUNNEL_INGRESS_PORT,
  VCLUSTER_EGRESS_FLOOR_NP_NAME,
} from './proxy-constants'
export {
  RelayExecError,
  bootStreamd,
  dialCtrlStream,
  dialPtyStream,
  invalidateRelayAddr,
  relayDial,
  relayTcpFactory,
  podExec,
  podStreamToken,
  waitForStreamd,
  type StreamChild,
} from './stream-relay'
export { formatTaint, untoleratedTaints } from './taints'
export type { NodeTaint, PodToleration } from './taints'
export { createTickSnapshot } from './tick-snapshot'
export type { TickSnapshot } from './tick-snapshot'
export {
  LABEL_VCLUSTER,
  LABEL_VCLUSTER_DATA_DIR_HASH,
  LABEL_VCLUSTER_SESSION_ID,
  listVclusterNamespaces,
} from './vcluster-objects'
export type { VclusterPod } from './vcluster-objects'
