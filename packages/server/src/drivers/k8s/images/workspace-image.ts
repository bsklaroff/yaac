import { ensureImage, pushImageShared } from './build-coordinator'
import { testEnv } from '@yaac/shared/env'
import type { ProjectRef } from '#drivers/contract'

/**
 * Build (or reuse) a project's workspace image, make sure it is in the
 * registry, and return the ref the cluster pulls. `nestedContainers` adds
 * the nestable layer (the in-pod engine) to the chain. Test image prefix
 * and prebuilt-only mode are read from the environment here, so callers
 * need not know about them.
 */
export async function prepareWorkspaceImage(opts: {
  project: ProjectRef
  nestedContainers: boolean
  onProgress?: (message: string) => void
}): Promise<string> {
  const emit = (m: string): void => opts.onProgress?.(m)

  emit('Ensuring container images are built...')
  const imageName = await ensureImage(
    opts.project,
    testEnv.imagePrefix,
    testEnv.requirePrebuiltImages,
    opts.nestedContainers,
    {
      reason: 'session',
      onLayerStart: (i, total, layer) =>
        emit(`Building image layer ${i}/${total} (${layer})...`),
    },
  )

  // Usually just a HEAD: every layer was either found in the registry or
  // pushed by its builder pod. The push covers a registry that lost the tag.
  emit('Publishing the session image to the local registry...')
  return pushImageShared(imageName, { project: opts.project, reason: 'session' })
}
