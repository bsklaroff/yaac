// The public interface of the host image engine (sealed folder; see the
// SEALED_FOLDERS lint rule).
//
// This is the half of image handling that needs no cluster: `podman build`
// on the host, the content-hash tags that decide whether a build is needed,
// the in-memory list of build rows the webapp shows, and the host image GC.
// #drivers/k8s/images is the half that needs a cluster (builder pods, the
// registry promoter, the prewarm sweep). They are split because
// `yaac cluster install` must build images, netd's included, before the
// cluster exists; one folder would make the two depend on each other.
//
// Each name exported here needs a unit test in
// packages/server/test/drivers/k8s/image-engine/.

export {
  baseImageHash,
  buildImage,
  contextHash,
  ensureImageByTag,
  fileHash,
  resolveImageChain,
  resolveTrustedLayers,
  stringHash,
  toolsContentHash,
  type ImageLayer,
} from './image-builder'
export {
  attachImageBuildProject,
  dismissImageBuild,
  failImageBuild,
  finishImageBuild,
  forgetImageBuild,
  getImageBuild,
  imageBuildProjects,
  getImageBuildLog,
  hasBlockingFailure,
  ingestImageBuildLine,
  listImageBuilds,
  registerImageBuild,
  type ImageBuildReason,
} from './image-builds'
export { gcHostImages } from './image-gc'
export { missingPrebuiltImage, prebuiltRef } from './prebuilt'
