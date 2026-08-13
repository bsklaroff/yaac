import { worktreeDriver } from '#drivers/driver'
import { teardownForRestart } from './cleanup'
import { createWorktree } from './create'
import {
  ensureProvisioning,
  failProvisioning,
  removeProvisioning,
  updateProvisioningMessage,
} from './provisioning'
import { clearWorktreeStopped, findWorktreeRow } from '#db'
import {
  firstAgentSession,
  listActiveAgentSessions,
} from '#db'
import { ServerError } from '@yaac/shared/errors'
import type { WorktreeCreateResult } from './create'
import type { AgentTool } from '@yaac/shared/types'

export interface RestartResolution {
  projectSlug: string
  worktreeId: string
  tool: AgentTool
  jobName: string | null
}

/**
 * Locate the project + tool for a worktree id or id prefix. Prefers a live
 * pod's labels (authoritative about tool) and falls back to the recorded
 * worktree row, so a stopped worktree can still be restarted against its
 * saved checkout and history.
 */
export async function resolveRestartTarget(idOrName: string): Promise<RestartResolution> {
  try {
    const match = await worktreeDriver().find(idOrName)
    if (match) {
      return {
        projectSlug: match.projectSlug,
        worktreeId: match.workspaceId,
        tool: match.tool,
        jobName: match.jobName,
      }
    }
  } catch {
    // Substrate unreachable — try the recorded row. If both paths fail we
    // surface NOT_FOUND below; RUNTIME_UNAVAILABLE would be misleading
    // since the restart may still succeed when the substrate recovers by
    // the time the create runs.
  }

  const row = await findWorktreeRow(idOrName)
  if (row) {
    // The tool is the first conversation's — a worktree has none of its own.
    // A worktree whose create died before recording one cannot say what to
    // launch, so it falls back to claude rather than refusing to restart.
    const first = await firstAgentSession(row.projectSlug, row.worktreeId)
    return {
      projectSlug: row.projectSlug,
      worktreeId: row.worktreeId,
      tool: first?.tool ?? 'claude',
      jobName: null,
    }
  }

  throw new ServerError(
    'NOT_FOUND',
    `No worktree found matching "${idOrName}". Run "yaac worktree list -s" to see stopped worktrees.`,
  )
}

export interface RestartWorktreeOptions {
  gitUser?: { name: string; email: string }
  onProgress?: (message: string) => void
}

/**
 * Tear down any existing Job for `idOrName` (preserving the git worktree) and
 * spin up a fresh one that resumes the agent sessions which were live when
 * the worktree stopped — each in its own window, in the order they were
 * first opened. All env, config, proxy rules, and port forwarders come from
 * the project config.
 *
 * The active set is read, not recomputed: teardown deliberately leaves
 * `worktree_agent_sessions.active` frozen at the pod's last observed state,
 * and that freeze is the whole point — a worktree stopped with two agents
 * running comes back with two, and one whose second agent was closed first
 * comes back with one.
 */
export async function restartWorktree(
  idOrName: string,
  opts: RestartWorktreeOptions = {},
): Promise<WorktreeCreateResult> {
  const { projectSlug, worktreeId, tool, jobName } = await resolveRestartTarget(idOrName)

  // Enter the provisioning registry before the teardown below, and here
  // rather than only in the route: the registry is what `inFlightWorktreeIds`
  // reads, and that is the ONLY thing standing between a restart and the
  // stale reaper. A caller that skipped it — the CLI, which passes no
  // projectSlug because it wants no row — spent its whole restart reapable,
  // and the reaper's teardown `rm -rf`s the session dirs (staged skills,
  // worktree bin) out from under the create that is about to mount them.
  // Registering after the resolve is what makes it possible at all: the
  // project and tool are the resolve's answer, which is exactly why the
  // route could only do this for a caller that already knew them.
  //
  // `ensure`, not `register`: the webapp registers up front so its row
  // renders during the resolve, and re-registering would reorder it.
  //
  // Registering here means retiring it here too, which `runProvisioned` above
  // cannot do for us: that wrapper is keyed on the id the CALLER passed, and
  // the CLI passes whatever the user typed — `yaac worktree restart eaa70e`
  // keys it on a PREFIX, while the entry below is keyed on the resolved id.
  // This is the only scope that holds both, so the resolve/fail pair is
  // explicit rather than inherited. Both calls are idempotent, so the
  // webapp's full-id path simply runs them twice.
  ensureProvisioning({ worktreeId, projectSlug, tool, kind: 'restart' })

  // Progress has to be mirrored here for the same keying reason: the route's
  // mirror addresses the caller's id, so for a prefix restart it updates
  // nothing and the row would sit at "Starting…" for the whole run.
  const onProgress = (message: string): void => {
    updateProvisioningMessage(worktreeId, message)
    opts.onProgress?.(message)
  }

  try {
    if (jobName) onProgress(`Stopping session job ${jobName}...`)
    // Always, not just when there was a Job: a terminating mark left by an
    // earlier teardown would render the fresh worktree as "stopping…".
    await teardownForRestart({ jobName, projectSlug, workspaceId: worktreeId })

    // Each conversation resumes under its OWN tool: a worktree can hold a
    // codex conversation next to claude ones, and launching the wrong binary
    // against an id it does not know kills the pane.
    const active = await listActiveAgentSessions(projectSlug, worktreeId).catch(() => [])
    const resume = active.map((l) => ({ agentSessionId: l.agentSessionId, tool: l.tool }))
    if (resume.length > 1) onProgress(`Restoring ${resume.length} agent sessions...`)

    // A worktree comes back the way it went down. Mode is per-conversation in
    // the schema but per-pod at launch (the driver is chosen once, from the pod
    // label), so the primary conversation's mode is the worktree's — which is
    // exact, since nothing today can mix modes inside one worktree. A worktree
    // with nothing recorded (an older row, or a create that never got an id)
    // falls back to tui, the mode every pre-ACP worktree ran.

    // A restart relaunches the agents the way the user asked for them, not
    // the way today's default would: the row remembers the choice, and a
    // worktree that was deliberately created without auto-approve must not
    // come back with it. A worktree with no row to read (a substrate-only
    // resolve) falls through to the driver's default.
    const recorded = await findWorktreeRow(worktreeId).catch(() => undefined)

    const result = await createWorktree(projectSlug, {
      // Always reuse the checkout — that is what a restart *is*. Clearing this
      // would send the create down `git worktree add` against a checkout that
      // is still there, fail, and roll the worktree row away with it.
      resume: true,
      worktreeId,
      tool,
      mode: active[0]?.mode ?? 'tui',
      resumeAgentSessions: resume,
      gitUser: opts.gitUser,
      ...(recorded !== undefined ? { autoApprove: recorded.autoApprove } : {}),
      onProgress,
    })

    // The worktree lives again — drop its stop record (and any death cause
    // from its previous life) so the stopped view can't show it as died. Only
    // after createWorktree succeeds: a failed restart leaves the record intact.
    await clearWorktreeStopped(projectSlug, worktreeId)

    // Retire the row: the worktree is up, and `buildSnapshot` HIDES a
    // worktree that still has one, so leaving it renders a permanently
    // "Starting…" placeholder in place of the live worktree.
    removeProvisioning(worktreeId)

    return result
  } catch (err) {
    // Keep the row, marked failed — that is what the dismissable error state
    // is for. It also stops shielding: `inFlightWorktreeIds` excludes an
    // errored entry, and a failed restart's rollback has already torn down
    // whatever it left, so it has nothing left to protect.
    failProvisioning(worktreeId, err instanceof Error ? err.message : String(err))
    throw err
  }
}
