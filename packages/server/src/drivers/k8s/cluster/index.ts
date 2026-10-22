// The public interface of the cluster feature (a sealed folder; see
// SEALED_FOLDERS).
//
// This feature owns the in-cluster datapath (egress proxy, netd, the main
// and per-project registries, the npm cache), the main registry's client
// and write grants, and the tag or digest of every image yaac ships.
// Building and pushing those images is `#drivers/k8s/install`'s job.
//
// Each name added here needs a unit test in
// packages/server/test/drivers/k8s/cluster/.
//
// Not here, so their users avoid loading cluster code: the datapath's names
// and ports (`#drivers/k8s/substrate`).

export {
  buildEgressWorldDenyNpManifest,
  buildProxyEgressNpManifest,
  buildProxyIngressNpManifest,
  buildServerFrontIngressNpManifest,
  buildServerIngressNpManifest,
  buildWorkspaceEgressNpManifest,
  wideEgress,
} from './policy-manifests'
export {
  nodeIpBlocks,
  podCidrSources,
  resetClusterCidrCache,
} from './cluster-cidrs'
export { reconcileNodeSet } from './node-sync'
export {
  PROJECT_REGISTRY_PORT,
  REGISTRY_APP_LABEL,
  REGISTRY_MIRROR_TAG,
  REGISTRY_UPSTREAM_IMAGE,
  buildRegistryRetentionScript,
  ensureProjectRegistry,
  gcOrphanProjectRegistries,
  projectRegistryClusterIp,
  projectRegistryConfDropIn,
  projectRegistryHost,
  reconcileProjectRegistryGc,
  removeProjectRegistry,
} from './project-registry'
export {
  ensureBuilderRoleGuard,
  ensureCaConfigMap,
  ensureNamespace,
  ensureProxyAuthSecret,
  ensureProxyResources,
  proxyServiceClusterIp,
  removeProjectSecrets,
  resetProxyClusterIpCache,
  syncProjectSecrets,
  syncProxyCredentials,
  vapAvailable,
} from './proxy-apply'
export { BUILDER_LOCAL_TAG, BUILDER_UPSTREAM_IMAGE, ensureBuilderImage } from './builder-image'
export { ensureProxyImage, resolveProxyImageTag } from './proxy-image'
export {
  ENVOY_MIRROR_TAG,
  ENVOY_UPSTREAM_IMAGE,
  DEFAULT_VETH_PREFIX,
  cniVethPrefix,
  ensureNetd,
  resolveNetdImageTag,
} from './netd'
export {
  buildBuilderRoleGuardBindingManifest,
  buildBuilderRoleGuardPolicyManifest,
  buildRegistrationConfigMapManifest,
  proxyRegistrationName,
} from './proxy-manifests'
export {
  baseImageHash,
  contextHash,
  fileHash,
  imagePrefix,
  resolveImageChain,
  resolveTrustedLayers,
  stringHash,
  toolsContentHash,
  type ImageLayer,
} from './image-tags'
export {
  MAIN_REGISTRY_APP_LABEL,
  ensureMainRegistry,
  mainRegistryExec,
} from './main-registry'
export {
  invalidateRegistryEndpoint,
  missingPrebuiltImage,
  prebuiltRef,
  registryEndpoint,
  registryHost,
  registryReachable,
  registryRef,
  registryTagState,
  REGISTRY_NAMESPACE,
  REGISTRY_SERVICE_NAME,
  REGISTRY_SERVICE_PORT,
} from './registry'
export { REGISTRY_GRANT_NAMESPACE, registryAuthFile } from './registry-grant'
export {
  NGINX_MIRROR_TAG,
  NGINX_UPSTREAM_IMAGE,
  VERDACCIO_MIRROR_TAG,
  VERDACCIO_UPSTREAM_IMAGE,
  ensureNpmCache,
  servingNpmCacheUrl,
} from './npm-cache'
