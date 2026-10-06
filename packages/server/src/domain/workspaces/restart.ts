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
import { serverLog } from '#log'
import {
  firstAgentSession,
  listActiveAgentSessions,
} from '#db'
import { ServerError } from '@yaac/shared/errors'
import type { WorkspaceCreateResult } from './create'
import { DEFAULT_AGENT_MODE, type AgentTool } from '@yaac/shared/types'

export interface RestartResolution {
  projectId: string
  workspaceId: string
  tool: AgentTool
  jobName: string | null
  /** Sidebar group (from the row), so the restarting row stays in place. */
  groupId?: string
}

/**
 * Find the project and tool for a workspace id or prefix: from the running
 * unit if any, else from the row, so stopped workspaces can be restarted.
 */
export async function resolveRestartTarget(idOrPrefix: string): Promise<RestartResolution> {
  const id = await resolveWorkspaceId(idOrPrefix)
  try {
    const match = await workspaceDriver().find(id)
    if (match) {
      // The group is only in the row; a failed read just means no group.
      const row = await findWorkspaceRow(match.workspaceId).catch(() => undefined)
      return {
        projectId: match.projectId,
        workspaceId: match.workspaceId,
        tool: match.tool,
        jobName: match.jobName,
        ...(row?.groupId !== undefined ? { groupId: row.groupId } : {}),
      }
    }
  } catch {
    // Substrate unreachable; try the row.
  }

  const row = await findWorkspaceRow(id)
  if (row) {
    // The tool is the first conversation's; claude if none was recorded.
    const first = await firstAgentSession(row.projectId, row.workspaceId)
    return {
      projectId: row.projectId,
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
 * Tear down any running unit (keeping the checkout) and launch a new one that
 * resumes the conversations active when the workspace stopped, each in its
 * own window. Teardown leaves the active set as last observed, so a
 * workspace comes back with the agents it had. Config comes fresh from the
 * project.
 */
export async function restartWorkspace(
  idOrPrefix: string,
  opts: RestartWorkspaceOptions = {},
): Promise<WorkspaceCreateResult> {
  const { projectId, workspaceId, tool, jobName, groupId } = await resolveRestartTarget(idOrPrefix)

  // Register before teardown, whoever the caller is: `inFlightWorkspaceIds`
  // is what keeps the stale reaper from deleting the dirs the new launch is
  // about to mount. `ensure` because the route may already have registered.
  // The remove/fail calls below are explicit for the same reason.
  ensureProvisioning({
    workspaceId,
    projectId,
    tool,
    kind: 'restart',
    ...(groupId !== undefined ? { groupId } : {}),
  })

  // Mirror progress here too, for callers without `runProvisioned`.
  const onProgress = (message: string): void => {
    updateProvisioningMessage(workspaceId, message)
    opts.onProgress?.(message)
  }

  try {
    if (jobName) onProgress(`Stopping session job ${jobName}...`)
    // Always: it also clears a leftover terminating mark.
    await teardownForRestart({ jobName, projectId, workspaceId: workspaceId })

    // Each conversation resumes under its own tool.
    const active = await listActiveAgentSessions(projectId, workspaceId).catch(() => [])
    if (active.length > 1) onProgress(`Restoring ${active.length} agent sessions...`)

    // Relaunch in the recorded permission mode (e.g. `plan` must not come
    // back as `bypass`), and in the first conversation's agent mode (one per
    // workspace), else the mode the workspace launched in. An `acp` launch
    // whose handshake failed records no conversation.
    const recorded = await findWorkspaceRow(workspaceId).catch(() => undefined)

    const result = await createWorkspace(projectId, {
      resume: true,
      workspaceId,
      tool,
      mode: active[0]?.mode ?? recorded?.mode ?? DEFAULT_AGENT_MODE,
      resumeAgentSessions: active,
      ...(recorded !== undefined ? { permissionMode: recorded.permissionMode } : {}),
      onProgress,
    })

    // Only after success, so a failed restart keeps its stop record. The
    // workspace is running either way, so a lost clear is only logged.
    await clearWorkspaceStopped(projectId, workspaceId).catch((err: unknown) => {
      serverLog(`[server] restart ${projectId}/${workspaceId}: clear stop: ${String(err)}`)
    })

    // `buildSnapshot` hides a workspace while its row exists.
    removeProvisioning(workspaceId)

    return result
  } catch (err) {
    // Keep the row as a dismissable error. It no longer shields the
    // workspace from sweeps; the rollback already cleaned up.
    failProvisioning(workspaceId, err instanceof Error ? err.message : String(err))
    throw err
  }
}
