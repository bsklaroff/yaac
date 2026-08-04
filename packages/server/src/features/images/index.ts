// The public interface of the images feature. Everything outside this
// directory imports `#features/images`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/images/. Modules not re-exported are
// internal: free to change shape without a test rewrite, and still covered —
// directly by their own tests, which may reach inside, and transitively
// through the entry points below.

export { reconcileBuildCacheGc } from './build-cache-gc'
export { ensureImage, pushImageShared, rebuildProjectImage } from './build-coordinator'
export {
  BUILDER_CONTEXT_MAX_BYTES,
  ensureBuilderImage,
  ensureBuilderRoleGuard,
  reconcileBuilderPodGc,
} from './builder-pod'
export {
  baseImageHash,
  buildImage,
  collectContextFiles,
  contextHash,
  ensureImageByTag,
  fileHash,
  isLayered,
  resolveImageChain,
  sessionUid,
  toolsContentHash,
} from './image-builder'
export {
  dismissImageBuild,
  failImageBuild,
  finishImageBuild,
  getImageBuildLog,
  ingestImageBuildLine,
  listImageBuilds,
  registerImageBuild,
} from './image-builds'
export { reconcileHostImageGc } from './image-gc'
export { reconcileImagePrewarm, retryImageBuild } from './image-prewarm'
export { primeSessionImages, salvageSessionImages } from './image-promoter'
export { tryClaimPrewarmed } from './prewarm'
export { reconcilePrewarmPool } from './prewarm-reconcile'
