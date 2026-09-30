/**
 * The review diff for a workspace pod, computed inside the pod because the
 * workspace's git metadata points at container paths. The script and its
 * output parser are driver-neutral and live in `#drivers/shared`; this file
 * runs the script in the pod and serializes access to its shared index.
 */

import { RelayExecError, k8sWorkspacePaths, podExec } from '#drivers/k8s/substrate'
import { CHANGES_BASE_UNRESOLVED, WorkspaceExecError } from '#drivers/contract'
import { createKeyedMutex } from '#lib/keyed-mutex'
import {
  buildChangesScript,
  parseChangesOutput,
  type ChangesLocation,
} from '#drivers/shared'
import type { WorkspaceChanges } from '@yaac/shared/types'

/** Where the diff runs in the pod. The index path is stable so git's stat
 *  cache survives between polls. */
function podLocation(): ChangesLocation {
  const paths = k8sWorkspacePaths()
  return {
    workspaceDir: paths.workspaceDir,
    indexFile: `${paths.scratchDir}/yaac-changes.idx`,
    baseUnresolvedCode: CHANGES_BASE_UNRESOLVED,
  }
}

/**
 * One run at a time per workspace: runs share one index, and overlapping
 * `git add -A` calls would collide on its lock.
 */
const changesMutex = createKeyedMutex()

/** Runs in flight, keyed by request. Every open tab polls independently, so
 *  identical concurrent requests share one exec. */
const inFlight = new Map<string, Promise<WorkspaceChanges>>()

/** Compute the review diff for a running workspace. `base` is an optional
 *  user-picked branch whose fork point the diff is taken against;
 *  `defaultBase` is the workspace's recorded fork branch (e.g. `main`), used
 *  otherwise so committed work stays visible after the agent renames and
 *  pushes its branch.
 *
 *  A nonzero exit becomes a `WorkspaceExecError` with the exit code, so the
 *  caller can tell a bad base (`CHANGES_BASE_UNRESOLVED`, a 400) from other
 *  failures (500). Transport errors pass through unchanged. */
export async function getWorkspaceChanges(jobName: string, base?: string, defaultBase?: string): Promise<WorkspaceChanges> {
  const key = [jobName, base ?? '', defaultBase ?? ''].join('\0')
  const shared = inFlight.get(key)
  if (shared) return shared

  const run = changesMutex(jobName, async () => {
    const { stdout } = await podExec(
      jobName, buildChangesScript(podLocation(), base, defaultBase),
      { timeout: 20_000, maxAttempts: 2 },
    ).catch((err: unknown) => {
      if (err instanceof RelayExecError) {
        throw new WorkspaceExecError(err.message, err.code, err.stdout, err.stderr, { cause: err })
      }
      throw err
    })
    return parseChangesOutput(stdout)
  })
  inFlight.set(key, run)
  try {
    return await run
  } finally {
    if (inFlight.get(key) === run) inFlight.delete(key)
  }
}
