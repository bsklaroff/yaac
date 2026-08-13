/**
 * The review diff for a worktree pod, computed pod-side.
 *
 * Pod-side because it has to be: the worktree's git metadata points at
 * container paths, so host-side git cannot read it. What the diff IS — the
 * script that stages the working tree into a private index and prints it,
 * and the parser for what comes back — is driver-neutral and lives in
 * `#lib/worktree-changes`; this file is the pod half, which is the exec, the
 * paths it runs against, and the concurrency around a shared index.
 */

import { RelayExecError, k8sWorkspacePaths, podExec } from '#drivers/k8s/substrate'
import { CHANGES_BASE_UNRESOLVED, WorkspaceExecError } from '#drivers/contract'
import { createKeyedMutex } from '#lib/keyed-mutex'
import {
  buildChangesScript,
  parseChangesOutput,
  type ChangesLocation,
} from '#drivers/shared'
import type { WorktreeChanges } from '@yaac/shared/types'

/** Where the diff runs inside a worktree pod. The index is a stable
 *  pod-local path so git's stat cache survives between polls. */
function podLocation(): ChangesLocation {
  const paths = k8sWorkspacePaths()
  return {
    workspaceDir: paths.workspaceDir,
    indexFile: `${paths.scratchDir}/yaac-changes.idx`,
    baseUnresolvedCode: CHANGES_BASE_UNRESOLVED,
  }
}

/**
 * One run at a time per worktree. The runs share a single pod-side index, and
 * two overlapping `git add -A` calls would collide on its lock; serializing
 * also keeps a polling client from stacking work on a pod whose worktree is
 * slow to walk.
 */
const changesMutex = createKeyedMutex()

/** Runs in flight, keyed by the exact request. The pane polls every few
 *  seconds and every open tab polls independently, so identical concurrent
 *  requests share one pod exec instead of queueing behind each other. */
const inFlight = new Map<string, Promise<WorktreeChanges>>()

/** Compute the review diff for a running worktree's worktree. `base`, when
 *  given, is a user-picked branch whose fork point the diff is taken against.
 *  `defaultBase` is the worktree's recorded fork branch (e.g. `main`), used as
 *  the default when no explicit `base` is given so committed work stays
 *  visible even after the agent renames and pushes its branch.
 *
 *  A script that RAN and exited nonzero crosses the contract as a
 *  `WorkspaceExecError` carrying the exit code, because that code is the
 *  whole of what the mediator has to tell a base that yielded nothing
 *  (`CHANGES_BASE_UNRESOLVED` — the one failure a caller can be at fault
 *  for) from a worktree that is not what we think it is. A transport
 *  failure proves neither and passes through as itself. The same
 *  distinction `exec` makes, drawn here because this is where the exit
 *  codes are defined — and it is what decides 400 vs 500 upstream. */
export async function getWorktreeChanges(jobName: string, base?: string, defaultBase?: string): Promise<WorktreeChanges> {
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
