import { worktreeDriver } from '#drivers/driver'
import { resolveProjectConfig } from '#domain/projects'
import { reapProjectSpares } from '#domain/worktrees'

/**
 * Rebuild a project's image from further up its chain than a content-hash
 * tag would invalidate, and publish it where a workspace can run it.
 * Answers the ref naming the finished image; `onLog` narrates, since a
 * rebuild runs for minutes and its output is the response.
 *
 * A mediator rather than a passthrough for one reason, and it is the same
 * one `retryImageBuild` exists for: WHICH chain a project runs follows from
 * its config, and the runtime may not read config at all. `nestedContainers`
 * inserts the nestable layer, so a rebuild that guessed it would rebuild
 * and publish `base → tools → user` while every one of the project's
 * worktrees runs the nestable chain's tag — the freshly installed agent
 * CLIs reaching nothing.
 *
 * That failure is silent, which is what makes resolving it here worth a
 * verb: the wrong chain builds fine, takes just as long, and reports
 * success. So the flag is required on the contract, not defaulted.
 *
 * `virtualCluster` implies `nestedContainers` — the in-pod podman is a
 * vcluster worktree's only build engine. The config parser normalizes that,
 * and reading both here keeps this agreeing with worktree create for a
 * config that never went through it.
 *
 * Dropping the project's prewarmed spares is the other half of "the rebuild
 * reached the user", and belongs here for the same reason the chain choice
 * does: this is what knows a rebuild happened. A spare's image was resolved
 * when it was warmed, and nothing else in the pool notices it has gone
 * stale — so the first create after a successful rebuild would claim a
 * pre-rebuild spare and hand back exactly the agent CLIs the rebuild
 * replaced. That is the worst-placed version of the symptom: the very next
 * worktree, right after watching the rebuild succeed.
 *
 * Only after the rebuild SUCCEEDS — a failed one changed nothing, so the
 * spares it warmed are still correct.
 */
export async function rebuildProjectImage(
  projectSlug: string,
  opts: { onLog?: (line: string) => void } = {},
): Promise<string> {
  const config = await resolveProjectConfig(projectSlug)
  const nestedContainers = config?.nestedContainers === true || config?.virtualCluster === true

  const finalTag = await worktreeDriver().rebuildImage(projectSlug, {
    nestedContainers,
    onLog: opts.onLog,
  })

  const reaped = await reapProjectSpares(projectSlug)
  if (reaped > 0) {
    opts.onLog?.(`Dropped ${reaped} prewarmed session${reaped === 1 ? '' : 's'} `
      + 'holding the old image; the pool refills itself.')
  }
  return finalTag
}
