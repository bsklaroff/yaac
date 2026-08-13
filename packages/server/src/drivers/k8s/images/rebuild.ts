import { pushImageShared, rebuildProjectImage } from './build-coordinator'
import { testEnv } from '@yaac/shared/env'

/**
 * A project rebuild, all the way to runnable: force the chain's stale
 * layers to rebuild, then publish the result where a workspace pulls from.
 *
 * The two halves are one verb because there is no caller that wants the
 * first without the second — a rebuilt image nothing can pull is invisible
 * to every worktree created after it, which is the whole point of asking.
 *
 * The push is FORCED, and that is the substance rather than a flag: a
 * rebuild changes image bytes under an unchanged content-hash tag, so the
 * ordinary has-tag skip would look at the registry, see the tag already
 * there, and publish nothing. Getting that wrong is silent — the rebuild
 * reports success and the cluster keeps running the old bytes.
 *
 * The caller decides only which project and whether its worktrees run
 * nested containers — the second because it selects the image CHAIN, the
 * same reason `prepareWorkspaceImage` takes it. Which prefix the test
 * fixtures pinned is substrate and read here, so no caller above the
 * runtime has to know it exists.
 *
 * A sibling of build-coordinator rather than another export on it, for the
 * reason `workspace-image` is: ESM intra-module calls bypass `vi.mock`, so
 * a caller's partial mock of the coordinator stops intercepting the moment
 * the composition lives inside it.
 */
export async function rebuildAndPushProjectImage(
  projectSlug: string,
  opts: { nestedContainers: boolean; onLog?: (line: string) => void },
): Promise<string> {
  const finalTag = await rebuildProjectImage(projectSlug, {
    nestedContainers: opts.nestedContainers,
    imagePrefix: testEnv.imagePrefix,
    onLog: opts.onLog,
  })
  opts.onLog?.('Pushing rebuilt image to the local registry...')
  await pushImageShared(finalTag, { projectSlug, reason: 'rebuild' }, { force: true })
  return finalTag
}
