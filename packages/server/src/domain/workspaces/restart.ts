import { workspaceDriver } from '#drivers/driver'
import { teardownForRestart } from './cleanup'
import { createWorkspace } from './create'
import { resolveWorkspaceId } from './resolve'
import {
  ensureProvisioning,
  failProvisioning,
  removeProvisioning,
  updateProvisioningMessage,
} from './provisioning'
import { clearWorkspaceStopped, findWorkspaceRow } from '#db'
import {
  firstAgentSession,
  listActiveAgentSessions,
} from '#db'
import { ServerError } from '@yaac/shared/errors'
import type { WorkspaceCreateResult } from './create'
import type { AgentTool } from '@yaac/shared/types'

export interface RestartResolution {
  projectSlug: string
  workspaceId: string
  tool: AgentTool
  jobName: string | null
  /** The sidebar group it is filed under, so the restarting row renders in
   *  that section rather than at the top of the list. Only the recorded row
   *  knows this — the substrate has no idea a workspace is grouped. */
  groupId?: string
}

/**
 * Locate the project + tool for a workspace id or id prefix. Prefers a live
 * pod's labels (authoritative about tool) and falls back to the recorded
 * workspace row, so a stopped workspace can still be restarted against its
 * saved checkout and history.
 */
export async function resolveRestartTarget(idOrPrefix: string): Promise<RestartResolution> {
  const id = await resolveWorkspaceId(idOrPrefix)
  try {
    const match = await workspaceDriver().find(id)
    if (match) {
      // The pod answered everything but the group, which is a sidebar fact and
      // lives only in the row. Absent or unreadable just means no group: this
      // read must not fail the restart, nor be mistaken by the catch below for
      // the substrate being unreachable.
      const row = await findWorkspaceRow(match.workspaceId).catch(() => undefined)
      return {
        projectSlug: match.projectSlug,
        workspaceId: match.workspaceId,
        tool: match.tool,
        jobName: match.jobName,
        ...(row?.groupId !== undefined ? { groupId: row.groupId } : {}),
      }
    }
  } catch {
    // Substrate unreachable — try the recorded row. If both paths fail we
    // surface NOT_FOUND below; RUNTIME_UNAVAILABLE would be misleading
    // since the restart may still succeed when the substrate recovers by
    // the time the create runs.
  }

  const row = await findWorkspaceRow(id)
  if (row) {
    // The tool is the first conversation's — a workspace has none of its own.
    // A workspace whose create died before recording one cannot say what to
    // launch, so it falls back to claude rather than refusing to restart.
    const first = await firstAgentSession(row.projectSlug, row.workspaceId)
    return {
      projectSlug: row.projectSlug,
      workspaceId: row.workspaceId,
      tool: first?.tool ?? 'claude',
      jobName: null,
      ...(row.groupId !== undefined ? { groupId: row.groupId } : {}),
    }
  }

  throw new ServerError(
    'NOT_FOUND',
    `No workspace found matching "${idOrPrefix}". Run "yaac workspace list -s" to see stopped workspaces.`,
  )
}

export interface RestartWorkspaceOptions {
  onProgress?: (message: string) => void
}

/**
 * Tear down any existing Job for `idOrPrefix` (preserving the checkout) and
 * spin up a fresh one that resumes the agent sessions which were live when
 * the workspace stopped — each in its own window, in the order they were
 * first opened. All env, config, proxy rules, and port forwarders come from
 * the project config.
 *
 * The active set is read, not recomputed: teardown deliberately leaves
 * `workspace_agent_sessions.active` frozen at the pod's last observed state,
 * and that freeze is the whole point — a workspace stopped with two agents
 * running comes back with two, and one whose second agent was closed first
 * comes back with one.
 */
export async function restartWorkspace(
  idOrPrefix: string,
  opts: RestartWorkspaceOptions = {},
): Promise<WorkspaceCreateResult> {
  const { projectSlug, workspaceId, tool, jobName, groupId } = await resolveRestartTarget(idOrPrefix)

  // Enter the provisioning registry before the teardown below, and here
  // rather than only in the route: the registry is what `inFlightWorkspaceIds`
  // reads, and that is the ONLY thing standing between a restart and the
  // stale reaper, whose teardown `rm -rf`s the session dirs (staged skills,
  // workspace bin) out from under the create that is about to mount them. So
  // the interlock lives with the restart itself, whoever called it.
  //
  // `ensure`, not `register`: the route registers up front so a restart of
  // one already provisioning is refused, and re-registering would reorder
  // its row. The resolve/fail pair below is explicit for the same reason —
  // this scope must hold the row whether or not a caller's `runProvisioned`
  // does. Both calls are idempotent, so the route's path runs them twice.
  ensureProvisioning({
    workspaceId,
    projectSlug,
    tool,
    kind: 'restart',
    // Filed where the workspace is, so the row stays in its sidebar section
    // for the whole restart instead of jumping to the top of the list.
    ...(groupId !== undefined ? { groupId } : {}),
  })

  // Progress is mirrored here for the same reason: a caller with no
  // `runProvisioned` of its own would leave the row at "Starting…".
  const onProgress = (message: string): void => {
    updateProvisioningMessage(workspaceId, message)
    opts.onProgress?.(message)
  }

  try {
    if (jobName) onProgress(`Stopping session job ${jobName}...`)
    // Always, not just when there was a Job: a terminating mark left by an
    // earlier teardown would render the fresh workspace as "stopping…".
    await teardownForRestart({ jobName, projectSlug, workspaceId: workspaceId })

    // Each conversation resumes under its OWN tool: a workspace can hold a
    // codex conversation next to claude ones, and launching the wrong binary
    // against an id it does not know kills the pane.
    const active = await listActiveAgentSessions(projectSlug, workspaceId).catch(() => [])
    if (active.length > 1) onProgress(`Restoring ${active.length} agent sessions...`)

    // A workspace comes back the way it went down. Mode is per-conversation in
    // the schema but per-pod at launch (the driver is chosen once, from the pod
    // label), so the primary conversation's mode is the workspace's — which is
    // exact, since nothing today can mix modes inside one workspace. A workspace
    // with nothing recorded (an older row, or a create that never got an id)
    // falls back to tui, the mode every pre-ACP workspace ran.

    // A restart relaunches the agents in the posture they were last in, not
    // the way today's default would: the row follows the running agent, and
    // a workspace left in `plan` or `manual` must not come back acting
    // freely. A workspace with no row to read (a substrate-only
    // resolve) falls through to the driver's default.
    const recorded = await findWorkspaceRow(workspaceId).catch(() => undefined)

    const result = await createWorkspace(projectSlug, {
      // Always reuse the checkout — that is what a restart *is*. Clearing this
      // would send the create down `createCheckout` against a checkout that
      // is still there, fail, and roll the workspace row away with it.
      resume: true,
      workspaceId,
      tool,
      mode: active[0]?.mode ?? 'tui',
      resumeAgentSessions: active,
      ...(recorded !== undefined ? { permissionMode: recorded.permissionMode } : {}),
      onProgress,
    })

    // The workspace lives again — drop its stop record (and any death cause
    // from its previous life) so the stopped view can't show it as died. Only
    // after createWorkspace succeeds: a failed restart leaves the record intact.
    await clearWorkspaceStopped(projectSlug, workspaceId)

    // Retire the row: the workspace is up, and `buildSnapshot` HIDES a
    // workspace that still has one, so leaving it renders a permanently
    // "Starting…" placeholder in place of the live workspace.
    removeProvisioning(workspaceId)

    return result
  } catch (err) {
    // Keep the row, marked failed — that is what the dismissable error state
    // is for. It also stops shielding: `inFlightWorkspaceIds` excludes an
    // errored entry, and a failed restart's rollback has already torn down
    // whatever it left, so it has nothing left to protect.
    failProvisioning(workspaceId, err instanceof Error ? err.message : String(err))
    throw err
  }
}
