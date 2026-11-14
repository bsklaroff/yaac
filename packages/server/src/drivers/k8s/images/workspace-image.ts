import { ensureImage } from './build-coordinator'
import { registryRef, resolveImageChain } from '#drivers/k8s/cluster'

interface WorkspaceImageOpts {
  projectId: string
  owner: string
}

/**
 * Build (or reuse) a project's workspace image and return the registry ref
 * the cluster pulls.
 */
export async function prepareWorkspaceImage(opts: WorkspaceImageOpts & {
  onProgress?: (message: string) => void
}): Promise<string> {
  const emit = (m: string): void => opts.onProgress?.(m)

  emit('Ensuring container images are built...')
  return registryRef(await ensureImage(opts.projectId, opts.owner, {
    reason: 'session',
    onLayerStart: (i, total, layer) =>
      emit(`Building image layer ${i}/${total} (${layer})...`),
  }))
}

/** The ref `prepareWorkspaceImage` would return now, from the chain's
 *  content hashes, without building or asking the registry. */
export async function currentWorkspaceImage(opts: WorkspaceImageOpts): Promise<string> {
  return registryRef((await resolveImageChain(opts.projectId, opts.owner)).finalTag)
}
