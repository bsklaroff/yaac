// Public interface of image handling on the cluster: sandboxed builder
// pods, the prewarm sweep, main registry GC, and the in-memory build rows
// the webapp shows. The yaac-shipped images are built on the host by
// `#drivers/k8s/install`; their tags come from `#drivers/k8s/cluster`.
//
// Each name exported here needs a unit test in
// packages/server/test/drivers/k8s/images/.

export { ensureImage } from './build-coordinator'
export { deleteLeakedBuilderPods } from './builder-pod'
export { dismissImageBuild, getImageBuildLog, listImageBuilds } from './image-builds'
export { reconcileImagePrewarm, retryImageBuild } from './image-prewarm'
export { currentWorkspaceImage, prepareWorkspaceImage } from './workspace-image'
export { reconcileMainRegistryGc } from './main-registry-gc'
