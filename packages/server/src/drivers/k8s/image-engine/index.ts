// The public interface of the host image engine. Everything outside this
// directory imports `#drivers/k8s/image-engine`; the SEALED_FOLDERS lint rule
// stops src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// This is the half of image handling that needs no cluster: `podman build` on
// the host, the content-hash tags that decide whether a build is needed at
// all, the in-memory registry of build rows the webapp shows, and the host
// image GC. #drivers/k8s/images is the other half — builder pods, the in-cluster
// registry promoter, the prewarm sweep — and it sits above #drivers/k8s/cluster
// because it needs one.
//
// The split exists because cluster install builds an image: netd's own image is
// produced by a plain host build before there is any cluster to build it in.
// With one images folder, that made the two features mutually dependent.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/image-engine/. Modules not re-exported are
// internal: free to change shape without a test rewrite, and still covered —
// directly by their own tests, which may reach inside, and transitively
// through the entry points below.

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
  type TrustedLayers,
} from './image-builder'
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
export { gcHostImages } from './image-gc'
export { missingPrebuiltImage } from './prebuilt'
