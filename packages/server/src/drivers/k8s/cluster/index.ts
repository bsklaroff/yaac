// The public interface of the cluster feature (a sealed folder; see
// SEALED_FOLDERS).
//
// This feature owns the in-cluster datapath (egress proxy, netd, the main
// registry, the npm cache, the public-site edge), the main registry's client
// and write grants, and the tag or digest of every image yaac ships.
// Building and pushing those images is `#drivers/k8s/install`'s job.
//
// Each name added here needs a unit test in
// packages/server/test/drivers/k8s/cluster/.
//
// Not here, so their users avoid loading cluster code: the datapath's names
// and ports (`#drivers/k8s/substrate`).

export {
  buildBuilderEgressNpManifest,
  buildEgressWorldDenyNpManifest,
  buildProxyEgressNpManifest,
  buildProxyIngressNpManifest,
  buildServerEgressNpManifest,
  buildServerFrontIngressNpManifest,
  buildServerIngressNpManifest,
  buildWorkspaceEgressNpManifest,
} from './policy-manifests'
export {
  apiserverEndpoints,
  clusterDnsCidrs,
  nodeAddressBlocks,
  nodeIpBlocks,
  podCidrSources,
  resetClusterCidrCache,
} from './cluster-cidrs'
export { reconcileNodeSet } from './node-sync'
export { sweepProjectRegistries } from './project-registry-sweep'
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
export { BUILDER_MIRROR_TAG, BUILDER_UPSTREAM_IMAGE, ensureBuilderImage } from './builder-image'
export { ensureProxyImage, resolveProxyImageTag } from './proxy-image'
export {
  ENVOY_MIRROR_TAG,
  ENVOY_UPSTREAM_IMAGE,
  DEFAULT_VETH_PREFIX,
  cniVethPrefix,
  ensureNetd,
  resolveNetdImageTag,
} from './netd'
export { buildDiskDaemonSetManifest, buildDiskIngressNpManifest } from './disk-pod'
export {
  buildBuilderRoleGuardBindingManifest,
  buildBuilderRoleGuardPolicyManifest,
  buildRegistrationConfigMapManifest,
  proxyRegistrationName,
  runSecretsName,
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
  REGISTRY_UPSTREAM_IMAGE,
  ensureMainRegistry,
  mainRegistryExec,
} from './main-registry'
export {
  invalidateRegistryEndpoint,
  mirrorMatchesRecord,
  mirrorRef,
  missingPrebuiltImage,
  prebuiltRef,
  recordMirrorDigest,
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
export {
  CLOUDFLARED_MIRROR_TAG,
  CLOUDFLARED_UPSTREAM_IMAGE,
  TAILSCALE_MIRROR_TAG,
  TAILSCALE_UPSTREAM_IMAGE,
  resolveTailgateImageTag,
  installedSiteDomain,
  siteTailnetDevice,
  siteTailnetStatus,
  ensureSiteEdge,
  siteCloudflareStatus,
  syncSiteObjects,
} from './site-edge'
