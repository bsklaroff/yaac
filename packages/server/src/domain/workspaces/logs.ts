/**
 * A workspace's terminal logs (docs/workspace-steps.md "Logs"): what each
 * window but an agent's printed, one dir per life, kept until the workspace
 * is deleted. Read from the host, so a stopped workspace's logs read the
 * same as a running one's, and only as a confined root, since the workspace
 * writes the dir (`openTerminalLogs`).
 */
import { constants as C } from 'node:fs'
import { ServerError } from '@yaac/shared/errors'
import { isAgentWindow, lifeDirName, type StepGraph } from '@yaac/shared/steps'
import type { WorkspaceLogLife } from '@yaac/shared/types'
import type { Actor } from '#domain/access'
import { findWorkspaceRow, listWorkspaceSteps } from '#db'
import { resolveWorkspaceId, resolveWorkspaceRecord } from './resolve'
import { authorizeWorkspace, stepName } from './steps'
import { openTerminalLogs } from './life'
import { inFlightWorkspaceIds } from './provisioning'

/** A life dir (`lifeDirName`) and a file in one, its window's name
 *  captured: no separators, no `..`. */
const LIFE = /^\d{4}-\d{2}-\d{2}T[\d.-]+Z$/
const FILE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\.(?:log(?:\.1)?|events)$/

/** At most this much of a log is answered at once. */
const READ_LIMIT = 4 * 1024 * 1024

/**
 * The graph each workflow of each life ran, by life dir and then by the
 * workflow's name in the workspace, from the step rows. Maps rather than
 * plain objects, since a workflow may be named after an `Object.prototype`
 * member (`constructor`), which a plain object already appears to hold.
 */
async function ranGraphs(workspaceId: string): Promise<Map<string, Map<string, StepGraph>>> {
  const graphs = new Map<string, Map<string, StepGraph>>()
  for (const s of await listWorkspaceSteps(workspaceId)) {
    const life = lifeDirName(s.life)
    const flows = graphs.get(life) ?? new Map<string, StepGraph>()
    graphs.set(life, flows.set(s.workflowName, { ...flows.get(s.workflowName), [s.name]: s.spec }))
  }
  return graphs
}

/** Each life's log files, newest life first, with the step specs its
 *  workflows ran. An agent session's logs are left out (`isAgentWindow`),
 *  though `readWorkspaceLog` still serves them. */
export async function listWorkspaceLogs(principal: Actor, idOrPrefix: string): Promise<WorkspaceLogLife[]> {
  const { projectId, workspaceId } = await resolveWorkspaceRecord(idOrPrefix)
  await authorizeWorkspace(principal, workspaceId)
  const logs = await openTerminalLogs(projectId, workspaceId)
  const graphs = await ranGraphs(workspaceId)
  const lives = (await logs.readdir('')).filter((d) => d.isDirectory() && LIFE.test(d.name)).map((d) => d.name).sort().reverse()
  return await Promise.all(lives.map(async (life) => {
    const names = (await logs.readdir(life)).flatMap((f) => {
      const window = f.isFile() ? FILE.exec(f.name)?.[1] : undefined
      return window !== undefined && !isAgentWindow(window) ? [f.name] : []
    }).sort()
    const files = await Promise.all(names.map(async (name) => ({ name, size: (await logs.stat(`${life}/${name}`))?.size ?? 0 })))
    return { life, files, workflows: Object.fromEntries(graphs.get(life) ?? []) }
  }))
}

/**
 * Up to 4 MiB of one log file from byte `offset`, and the offset after it,
 * so a client follows a log that is still being written by asking again
 * from there.
 */
export async function readWorkspaceLog(
  principal: Actor,
  idOrPrefix: string,
  life: string,
  file: string,
  offset = 0,
): Promise<{ data: Buffer; next: number; size: number }> {
  if (!LIFE.test(life) || !FILE.test(file)) throw new ServerError('VALIDATION', 'not a log file')
  const { projectId, workspaceId } = await resolveWorkspaceRecord(idOrPrefix)
  await authorizeWorkspace(principal, workspaceId)
  const logs = await openTerminalLogs(projectId, workspaceId)
  const handle = await logs.open(`${life}/${file}`, C.O_RDONLY).catch(() => {
    throw new ServerError('NOT_FOUND', `no log ${life}/${file}`)
  })
  try {
    const { size } = await handle.stat()
    const start = Math.min(Math.max(0, offset), size)
    const data = Buffer.alloc(Math.min(READ_LIMIT, size - start))
    const { bytesRead } = await handle.read(data, 0, data.length, start)
    return { data: data.subarray(0, bytesRead), next: start + bytesRead, size }
  } finally {
    await handle.close()
  }
}

/**
 * A workspace's steps, newest life first, each with its state and its log
 * files' sizes, and where the workspace stands: provisioning with no row
 * yet, or stopped with the outcome its steps had. For an agent following a
 * CI run or a site's release (`yaac-mama status` and `logs`); a stopped
 * workspace's rows keep the states its last life left. Any user may read
 * them.
 */
export async function workspaceSteps(idOrPrefix: string) {
  const workspaceId = await resolveWorkspaceId(idOrPrefix, { provisioning: true })
  const row = await findWorkspaceRow(workspaceId)
  if (row === undefined) {
    if (inFlightWorkspaceIds(Date.now()).includes(workspaceId)) return { workspaceId, provisioning: true as const, lives: [] }
    throw new ServerError('NOT_FOUND', `workspace ${idOrPrefix} not found`)
  }
  const logs = await openTerminalLogs(row.projectId, workspaceId)
  const steps = await listWorkspaceSteps(workspaceId)
  const lives = [...new Set(steps.map((s) => s.life.getTime()))].sort((a, b) => b - a)
  return {
    workspaceId,
    ...(row.stoppedAt !== undefined ? { stopped: true as const } : {}),
    ...(row.stepsOutcome !== undefined ? { stepsOutcome: row.stepsOutcome } : {}),
    life: lifeDirName(row.lifeStartedAt),
    lives: await Promise.all(lives.map(async (at) => ({
      life: lifeDirName(new Date(at)),
      steps: await Promise.all(steps.filter((s) => s.life.getTime() === at).map(async (s) => ({
        name: stepName(s),
        step: s.name,
        state: s.state,
        ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
        needs: s.spec.needs ?? [],
        ...(s.spec.service === true ? { service: true as const } : {}),
        started: s.startedAt !== undefined,
        logs: await Promise.all([`${stepName(s)}.log.1`, `${stepName(s)}.log`].map(async (file) => ({
          file, size: (await logs.stat(`${lifeDirName(s.life)}/${file}`))?.size ?? 0,
        }))),
      }))),
    }))),
  }
}
