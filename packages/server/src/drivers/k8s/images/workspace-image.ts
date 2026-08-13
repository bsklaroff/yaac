import { ensureImage, pushImageShared } from './build-coordinator'
import { registryDigestRef } from '#drivers/k8s/container'
import { testEnv } from '@yaac/shared/env'

/**
 * The image half of a workspace launch: build (or reuse) the project's
 * image, then publish it where the cluster can pull it, and answer with the
 * ref that names it there.
 *
 * The answer is a DIGEST ref, not the content-hash tag that was pushed, and
 * this is the one place that conversion belongs: it is the last point that
 * knows the bytes a launch means, and every consumer downstream treats the
 * ref as opaque. Tags are immutable in every flow but `yaac project
 * rebuild`, which exists to publish new bytes under an unchanged tag —
 * so a node whose containerd already holds that tag would never re-pull
 * it, and a worktree created after a rebuild would start from the
 * pre-rebuild image. Pinning here makes the pods' `IfNotPresent` exact:
 * a digest hit is the right bytes by construction. A running workspace is
 * unaffected either way — it runs from the node's extracted snapshot,
 * which is intended.
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

  emit('Pushing session image to the local registry...')
  await pushImageShared(imageName, { projectSlug: opts.projectSlug, reason: 'session' })
  return registryDigestRef(imageName)
}
