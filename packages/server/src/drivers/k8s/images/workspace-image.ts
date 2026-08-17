import { ensureImage, pushImageShared } from './build-coordinator'
import { testEnv } from '@yaac/shared/env'

/**
 * The image half of a workspace launch: build (or reuse) the project's
 * image, then publish it where the cluster can pull it, and answer with the
 * ref that names it there.
 *
 * The caller decides only which project and whether the workspace runs
 * nested containers — the second because it changes the image CHAIN (the
 * nestable layer is what carries an in-pod engine). Everything else is
 * substrate: which prefix the test fixtures pinned, whether a build is
 * allowed at all, the content-hash tag that decides there is nothing to do,
 * and the registry the pod resolves. Those are read here rather than passed
 * in, so no caller above the runtime has to know they exist.
 *
 * Progress is reported through the caller's callback because the caller
 * owns the create's user-visible narration; a build is the longest step it
 * has, and the layer messages come from deep inside this half.
 */
export async function prepareWorkspaceImage(opts: {
  projectSlug: string
  nestedContainers: boolean
  onProgress?: (message: string) => void
}): Promise<string> {
  const emit = (m: string): void => opts.onProgress?.(m)

  emit('Ensuring container images are built...')
  const imageName = await ensureImage(
    opts.projectSlug,
    testEnv.imagePrefix,
    testEnv.requirePrebuiltImages,
    opts.nestedContainers,
    {
      reason: 'session',
      onLayerStart: (i, total, layer) =>
        emit(`Building image layer ${i}/${total} (${layer})...`),
    },
  )

  // Answer with the ref the cluster resolves. In practice the tag is
  // already in the registry — every layer above was either looked up there
  // or built by a pod that pushed it — so this is a HEAD, and the push
  // behind it is the backstop for a registry that lost the tag mid-run.
  emit('Publishing the session image to the local registry...')
  return pushImageShared(imageName, { projectSlug: opts.projectSlug, reason: 'session' })
}
