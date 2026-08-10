import { isPrewarmed, listWorktreePods } from '#platform/k8s'
import { proxyClient } from './proxy-client'
import { addAllowedHostToProjectConfig } from '#store/projects'
import { ServerError } from '@yaac/shared/errors'

/**
 * Allow a previously-blocked egress host for a running worktree (the webapp
 * click-to-allow action). Without persist the widen is live-only: it exists in
 * the proxy's registration for this one worktree and is gone when the worktree
 * is recreated. With persist the host is first written into the project's
 * yaac-config.json (so every future worktree inherits it) and the live widen is
 * fanned out to all of the project's currently-running worktrees — the proxy
 * reports worktrees it has no registration for (allowHost → false), which the
 * fan-out tolerates, while a miss on the directly-targeted worktree is an error
 * the user should see.
 */
export async function allowWorktreeHost(
  target: { worktreeId: string; projectSlug: string },
  host: string,
  opts: { persist: boolean },
): Promise<void> {
  await proxyClient.attachIfRunning()

  if (!opts.persist) {
    if (!(await proxyClient.allowHost(target.worktreeId, host))) {
      throw new ServerError(
        'CONFLICT',
        `session ${target.worktreeId} is not registered with the egress proxy`,
      )
    }
    return
  }

  await addAllowedHostToProjectConfig(target.projectSlug, host)
  // Just the project's pods — not listActiveWorktrees, whose per-worktree
  // status/first-message/blocked-hosts reads the fan-out has no use for.
  const pods = await listWorktreePods(target.projectSlug)
  await Promise.all(
    pods
      .filter((p) => p.running && p.worktreeId && !isPrewarmed(p))
      .map((p) => proxyClient.allowHost(p.worktreeId, host)),
  )
}
