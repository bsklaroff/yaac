/**
 * A workspace life's start (docs/workspace-steps.md "Lives"): the graph it
 * starts and the log hooks its windows are opened under. Apart from the
 * step reconcile so a create can start a life without importing what the
 * reconcile drives.
 */
import fs from 'node:fs/promises'
import type { WorkspacePaths } from '#drivers/contract'
import { getWorkflow, type LifeWorkflow, type WorkspaceRow } from '#db'
import { listInitWorkflows, missingRepos } from '#domain/projects'
import { openSandboxDir } from '#runtime/agents'
import { lifeHooksConfig, sourceHooksCommand } from '#runtime/terminals'
import type { ConfinedRoot } from '#lib/confined-fs'
import { terminalLogDir } from '@yaac/shared/project-paths'
import { findCycle, fullNeed, lifeDirName, stepFullName } from '@yaac/shared/steps'

/** The workflows a life starts, and the init workflows it skips for lack
 *  of a repo, with the folders it lacks. */
export interface LifeStart {
  flows: LifeWorkflow[]
  skipped: Array<{ id: string; name: string; missing: string[] }>
}

/**
 * A workspace's start workflows (docs/workflows.md "Init workflows"): the
 * workflow its create brought, under the name it has there, else each of
 * its project's init workflows whose repos `repoIds` (its checkouts) has.
 * A step in a cycle through several workflows starts skipped.
 */
export async function startStepsOf(
  projectId: string,
  row: Pick<WorkspaceRow, 'workflowId' | 'workflowName'> | undefined,
  repoIds: string[],
): Promise<LifeStart> {
  const own = row?.workflowId !== undefined ? await getWorkflow(row.workflowId) : undefined
  if (own !== undefined) return { flows: [{ id: own.id, name: row?.workflowName ?? '', steps: own.steps }], skipped: [] }
  const flows: LifeWorkflow[] = []
  const skipped: LifeStart['skipped'] = []
  for (const w of await listInitWorkflows(projectId)) {
    const missing = await missingRepos(projectId, w.workflow.repos, repoIds)
    if (missing.length > 0) skipped.push({ id: w.workflow.id, name: w.name, missing })
    else flows.push({ id: w.workflow.id, name: w.name, steps: w.workflow.steps })
  }
  return { flows: skipCycles(flows), skipped }
}

/** Mark the steps of a cycle through several workflows skipped, as a step
 *  whose need can never be met. */
function skipCycles(flows: LifeWorkflow[]): LifeWorkflow[] {
  if (flows.length < 2) return flows
  const graph: Record<string, string[]> = {}
  for (const f of flows) {
    for (const [name, spec] of Object.entries(f.steps)) {
      graph[stepFullName(f.name, name)] = (spec.needs ?? []).map((n) => fullNeed(f.name, n))
    }
  }
  const cyclic = new Set<string>()
  for (let cycle = findCycle(graph); cycle !== undefined; cycle = findCycle(graph)) {
    for (const name of cycle) {
      cyclic.add(name)
      graph[name] = []
    }
  }
  if (cyclic.size === 0) return flows
  return flows.map((f) => ({ ...f, skip: Object.keys(f.steps).filter((n) => cyclic.has(stepFullName(f.name, n))) }))
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
