import { ensureImage } from './build-coordinator'
import { registryRef } from '#drivers/k8s/cluster'

/**
 * Build (or reuse) a project's workspace image and return the registry ref
 * the cluster pulls. `nestedContainers` adds the nestable layer (the in-pod
 * engine) to the chain.
 */
export async function prepareWorkspaceImage(opts: {
  projectId: string
  owner: string
  nestedContainers: boolean
  onProgress?: (message: string) => void
}): Promise<string> {
  const emit = (m: string): void => opts.onProgress?.(m)

  emit('Ensuring container images are built...')
  return registryRef(await ensureImage(opts.projectId, opts.owner, {
    nestedContainers: opts.nestedContainers,
    reason: 'session',
    onLayerStart: (i, total, layer) =>
      emit(`Building image layer ${i}/${total} (${layer})...`),
  }))
}
