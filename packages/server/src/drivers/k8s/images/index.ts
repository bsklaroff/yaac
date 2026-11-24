// Public interface of image handling on the cluster: sandboxed builder
// pods and main registry GC. Which builds run, and their records, are
// `#domain/images`'. The yaac-shipped images are built on the host by
// `#drivers/k8s/install`; their tags come from `#drivers/k8s/cluster`.
//
// Each name exported here needs a unit test in
// packages/server/test/drivers/k8s/images/.

export { buildImageLayers, imageRef, missingImageLayers, resolveChain } from './build-coordinator'
export { deleteLeakedBuilderPods } from './builder-pod'
export { reconcileMainRegistryGc } from './main-registry-gc'
