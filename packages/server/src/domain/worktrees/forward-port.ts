import { worktreeRuntime } from '#runtime/driver'
import { addPortForwardToProjectConfig } from '#domain/projects'
import { resolveWorktreeContainer } from './resolve'
import { ServerError } from '@yaac/shared/errors'
import type { PortMapping } from '@yaac/shared/types'

/**
 * Forward a port a worktree is listening on but nothing reaches yet — the
 * webapp's click-to-forward action, and `allowWorktreeHost`'s twin in every
 * respect: `persist` writes the port into the project's yaac-config.json so
 * future worktrees inherit it, and persisting implies the fan-out to the
 * project's other running worktrees for the same reason.
 *
 * The eligibility check comes FIRST, ahead of the config write, and that
 * ordering is the substance rather than a detail. WHICH ports are eligible is
 * the runtime's answer — only a listener it currently reports as unforwarded
 * may be named, which is what keeps this from being a "forward any port"
 * verb — but a request that is going to be refused must be refused before
 * anything durable happens. Otherwise a click racing the surfaced list
 * writes a port into the project config, inherited by every future worktree,
 * and then fails with an error saying nothing happened.
 *
 * `forwardPort` re-checks, and it is the authority: the read below is a
 * question asked a moment earlier, not a reservation.
 */
export async function forwardWorktreePort(
  idOrName: string,
  containerPort: number,
  opts: { persist: boolean },
): Promise<PortMapping> {
  const runtime = worktreeRuntime()
  const target = await resolveWorktreeContainer(idOrName, { requireRunning: true })
  if (!(await runtime.unforwardedPorts(target.worktreeId)).includes(containerPort)) {
    throw new ServerError(
      'CONFLICT',
      `port ${containerPort} is not an unforwarded listener in session ${target.worktreeId.slice(0, 8)}`,
    )
  }
  if (opts.persist) await addPortForwardToProjectConfig(target.projectSlug, containerPort)
  return runtime.forwardPort(
    { workspaceId: target.worktreeId, projectSlug: target.projectSlug, jobName: target.jobName },
    containerPort,
    { fanOutToProject: opts.persist },
  )
}
