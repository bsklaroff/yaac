// The public interface of the images feature (a sealed folder; see
// SEALED_FOLDERS).
//
// This feature owns images (docs/image-builds.md): a project's named
// Dockerfiles and a user's own, their revisions and support files, which
// builds run and their records, what a create launches, the image sweep,
// and what image GC keeps. The builds themselves run in the driver.
//
// Each name added here needs a unit test in packages/server/test/domain/images/.

export {
  activeImageBuilds,
  buildConcurrency,
  failInterruptedBuilds,
  setBuildConcurrency,
} from './builds'
export {
  allowBuildHost,
  buildLog,
  cancelBuild,
  createProjectImage,
  deleteImage,
  getBuild,
  getImageDetail,
  getUserImage,
  imageForCreate,
  listBuilds,
  listProjectImages,
  listRevisions,
  readImageFile,
  removeProjectImages,
  requestImageBuild,
  resolveImageName,
  restoreRevision,
  retryBuild,
  saveImage,
  saveUserImage,
  setDefaultImage,
  setImageCacheDays,
  spareImageTag,
  uploadImageFile,
  type CreateImage,
  type ImageContent,
  type SaveResult,
} from './images'
export { importLegacyBuildDirs } from './legacy-import'
export { keptImageTags, pruneImageBlobs, reconcileImageSweep } from './sweep'
