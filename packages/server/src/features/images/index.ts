// The public interface of the images feature: everything about a PROJECT's
// image chain — the single-flight coordinator over its layers, the in-cluster
// registry promoter, the prewarm sweep and the build-cache GC. How any one
// image is actually realized is #features/image-engine, which sits BELOW
// #features/cluster because cluster setup builds netd's image.
//
// Everything outside this directory imports `#features/images`; the
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
export { ensureImage, pushImageShared, rebuildProjectImage } from './build-coordinator'
export { reconcileImagePrewarm, retryImageBuild } from './image-prewarm'
export { primeSessionImages, salvageSessionImages } from './image-promoter'
