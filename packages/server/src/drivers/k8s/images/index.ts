// The public interface of the images feature: the half of image handling that
// needs a cluster — sandboxed builder pods, the in-cluster registry promoter,
// the prewarm sweep and the build-cache GC. The host-side half (podman build,
// content-hash tags, the build-row registry, host GC) is #drivers/k8s/image-engine
// and sits BELOW #drivers/k8s/cluster, which builds netd's image before there is
// a cluster to build it in.
//
// Everything outside this directory imports `#drivers/k8s/images`; the
// SEALED_FOLDERS lint rule stops src from reaching past this file. Modules in
// here import each other by relative path, which is why they are unaffected by
// that rule.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/images/. Modules not re-exported are
// internal: free to change shape without a test rewrite, and still covered —
// directly by their own tests, which may reach inside, and transitively
// through the entry points below.

export { reconcileBuildCacheGc } from './build-cache-gc'
export { ensureImage } from './build-coordinator'
export { ensureBuilderImage, reconcileBuilderPodGc } from './builder-pod'
export { reconcileImagePrewarm, retryImageBuild } from './image-prewarm'
export { salvageWorktreeImages } from './image-promoter'
export { prepareWorkspaceImage } from './workspace-image'
export {
  ensureNodeImageStore,
  nodeImageStoreMount,
  reconcileNodeImageStores,
  removeNodeImageStore,
} from './store-writer'
