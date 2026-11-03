/**
 * A workspace life's start (docs/workspace-steps.md "Lives"): the graph it
 * starts, its record, and the log hooks its windows are opened under. Apart
 * from the step reconcile so a create can start a life without importing
 * what the reconcile drives.
 */
import fs from 'node:fs/promises'
import type { WorkspacePaths } from '#drivers/contract'
import { applyWorkspaceEvent, getProjectRow, type WorkspaceRow } from '#db'
import { openSandboxDir } from '#runtime/agents'
import { lifeHooksConfig, sourceHooksCommand } from '#runtime/terminals'
import type { ConfinedRoot } from '#lib/confined-fs'
import { terminalLogDir } from '@yaac/shared/project-paths'
import { lifeDirName, type StepGraph } from '@yaac/shared/steps'

/** A workspace's start graph: the one its create brought, else its
 *  project's current init steps. */
export async function startStepsOf(projectId: string, row: Pick<WorkspaceRow, 'startSteps'> | undefined): Promise<StepGraph> {
  return row?.startSteps ?? (await getProjectRow(projectId))?.initSteps ?? {}
}

/** Record a new life starting `graph`, before any window of it opens.
 *  Resolves with when it started, which names its log dir. */
export async function recordLife(projectId: string, workspaceId: string, graph: StepGraph): Promise<Date> {
  const at = new Date()
  await applyWorkspaceEvent({ type: 'workspace-life-started', projectId, workspaceId, at, startSteps: graph })
  return at
}

/**
 * Write the tmux config a life sources (`lifeHooksConfig`) into its log
 * dir, and resolve with the command that sources it, which the caller runs
 * before opening any window of the life.
 */
export async function lifeHooksExec(projectId: string, workspaceId: string, life: Date, paths: WorkspacePaths): Promise<string> {
  const dir = lifeDirName(life)
  const logs = await openTerminalLogs(projectId, workspaceId)
  await logs.writeAtomic(`${dir}/hooks.conf`, lifeHooksConfig(paths, `${paths.terminalLogDir}/${dir}`))
  return sourceHooksCommand(paths, `${paths.terminalLogDir}/${dir}/hooks.conf`)
}

/**
 * A workspace's terminal log dir, which its runtime writes (under k8s, any
 * pod of it, through a read-write mount), so anything below the dir may be
 * a link or FIFO the workspace planted: it is only ever touched as a
 * confined root (docs/workspace-storage.md "Sandbox-writable dirs").
 */
export async function openTerminalLogs(projectId: string, workspaceId: string): Promise<ConfinedRoot> {
  const dir = terminalLogDir(projectId, workspaceId)
  // The dir itself is the mount root, which no workspace can replace.
  await fs.mkdir(dir, { recursive: true })
  return await openSandboxDir(projectId, dir)
}
