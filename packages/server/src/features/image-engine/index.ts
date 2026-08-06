// The public interface of the image engine. Everything outside this
// directory imports `#features/image-engine`; the SEALED_FOLDERS lint rule
// stops src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// This is the whole of "realize an image": the content-hash tags that decide
// whether a build is needed at all, the builder seam and its two backends
// (in-cluster builder pods, host podman), the ephemeral builder pods
// themselves, the in-memory registry of build rows the webapp shows, and the
// host image GC. #features/images is the layer above — the single-flight
// coordinator over a project's chain, the in-cluster registry promoter, the
// prewarm sweep, the build-cache GC.
//
// This folder sits BELOW #features/cluster, which is the constraint that
// shapes it: cluster setup builds netd's image, so anything here that needs
// the cluster stood up first takes it as an argument (`EnsureBuilderHost`)
// rather than importing that feature and putting the two in a cycle.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/image-engine/. Modules not re-exported are
// internal: free to change shape without a test rewrite, and still covered —
// directly by their own tests, which may reach inside, and transitively
// through the entry points below.

export {
  baseImageHash,
  contextHash,
  ensureImageByTag,
  fileHash,
  resolveImageChain,
  stringHash,
  toolsContentHash,
  type ImageLayer,
} from './image-builder'
export {
  ensureImageBuildRuntime,
  ensureMirroredImage,
  imageBuilder,
  imageBuilderKind,
  withImageBuilder,
  type ImageBuilder,
} from './builder'
export {
  buildBuilderEgressNetworkPolicyManifest,
  layerBuildTrust,
  reconcileBuilderPodGc,
  BUILD_CACHE_TTL,
  SHIPPED_BUILD_CACHE_REPO,
} from './builder-pod'
export {
  attachImageBuildProject,
  dismissImageBuild,
  failImageBuild,
  finishImageBuild,
  forgetImageBuild,
  getImageBuild,
  getImageBuildLog,
  hasBlockingFailure,
  ingestImageBuildLine,
  listImageBuilds,
  registerImageBuild,
  type ImageBuildReason,
} from './image-builds'
export { reconcileHostImageGc } from './image-gc'
