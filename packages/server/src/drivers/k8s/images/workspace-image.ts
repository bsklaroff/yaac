import { ensureImage } from './build-coordinator'
import { registryRef } from '#drivers/k8s/container'
import { testEnv } from '@yaac/shared/env'

/**
 * Build (or reuse) a project's workspace image and return the registry ref
 * the cluster pulls. `nestedContainers` adds the nestable layer (the in-pod
 * engine) to the chain. Test image prefix and prebuilt-only mode are read
 * from the environment here, so callers need not know about them.
 */
export async function prepareWorkspaceImage(opts: {
  projectId: string
  nestedContainers: boolean
  onProgress?: (message: string) => void
}): Promise<string> {
  const emit = (m: string): void => opts.onProgress?.(m)

  emit('Ensuring container images are built...')
  return registryRef(await ensureImage(
    opts.projectId,
    testEnv.imagePrefix,
    testEnv.requirePrebuiltImages,
    opts.nestedContainers,
    {
      reason: 'session',
      onLayerStart: (i, total, layer) =>
        emit(`Building image layer ${i}/${total} (${layer})...`),
    },
  ))
}
