import fs from 'node:fs/promises'
import path from 'node:path'
import { getProjectsDir } from '@yaac/shared/paths'
import { serverLog } from '#lib/log'
import { containerlessJobName, markerPath, containerlessStateDir } from './paths'
import type {
  AgentMode,
  AgentTool,
  WorkspaceDeathCause,
} from '@yaac/shared/types'
import type { RuntimeHandle, RuntimeSnapshot, StrayUnit, TeardownTarget } from '#drivers/contract'

/**
 * The workspaces this driver holds (the k8s driver asks the apiserver
 * instead). Kept as a marker file per workspace, which survives a server
 * restart, and an in-memory table that answers reads. Workspaces routinely
 * outlive the server, so recovery from markers is the normal path.
 */

/** The marker file: what only the launch knew. */
export interface WorkspaceMarker {
  projectId: string
  workspaceId: string
  tool: AgentTool
  mode: AgentMode
  createdAtMs: number
  /** The tmux server's pid, for the port scan. Pids are recycled, so it is
   *  only used alongside a socket liveness check. */
  tmuxPid?: number
  /** The workspace's ssh-agent (SSH remotes only), which holds a private
   *  key and is killed at teardown. Verified before signalling, since pids
   *  are recycled. */
  sshAgentPid?: number
  /**
   * The launch's own env entries (caller's and git's) minus credentials, so
   * a restarted server can rebuild `workspaceRunEnvironment`.
   */
  launchEnv: Record<string, string>
}

/** In-memory entry: the marker plus observed state. */
interface Entry {
  marker: WorkspaceMarker
  running: boolean
  deathCause: WorkspaceDeathCause
  /** The full environment, credentials included; in memory only, for
   *  workspaces this server launched. */
  env?: NodeJS.ProcessEnv
}

const entries = new Map<string, Entry>()

/** Test helper: forget everything. */
export function _resetRegistryForTests(): void {
  entries.clear()
}

export function rememberWorkspace(marker: WorkspaceMarker, env?: NodeJS.ProcessEnv): RuntimeHandle {
  entries.set(marker.workspaceId, {
    marker,
    running: true,
    deathCause: { reason: 'pod-stopped' },
    ...(env !== undefined ? { env } : {}),
  })
  return findWorkspace(marker.workspaceId) as RuntimeHandle
}

export function forgetWorkspace(workspaceId: string): void {
  entries.delete(workspaceId)
}

/** Record observed liveness; returns whether it changed. */
export function observeLiveness(
  workspaceId: string,
  running: boolean,
  deathCause: WorkspaceDeathCause,
): boolean {
  const entry = entries.get(workspaceId)
  if (!entry) return false
  if (entry.running === running) return false
  entry.running = running
  entry.deathCause = deathCause
  return true
}

export function workspaceEnv(workspaceId: string): NodeJS.ProcessEnv | undefined {
  return entries.get(workspaceId)?.env
}

export function workspaceLaunchEnv(workspaceId: string): Record<string, string> | undefined {
  return entries.get(workspaceId)?.marker.launchEnv
}

export function tmuxPidOf(workspaceId: string): number | undefined {
  return entries.get(workspaceId)?.marker.tmuxPid
}

function toHandle(entry: Entry): RuntimeHandle {
  const { marker } = entry
  return {
    workspaceId: marker.workspaceId,
    projectId: marker.projectId,
    jobName: containerlessJobName(marker.projectId, marker.workspaceId),
    tool: marker.tool,
    declaredTool: marker.tool,
    mode: marker.mode,
    running: entry.running,
    state: entry.running ? 'running' : 'failed',
    // Host processes have no labels.
    labels: {},
    createdAtMs: marker.createdAtMs,
    // No spare pool here (creates are already fast).
    prewarmed: false,
    // The domain's terminating mark covers a teardown in progress.
    terminating: false,
    deathCause: entry.deathCause,
  }
}

/** The workspace with this exact id. */
export function findWorkspace(workspaceId: string): RuntimeHandle | undefined {
  const entry = entries.get(workspaceId)
  return entry ? toHandle(entry) : undefined
}

export function findForTeardown(workspaceId: string): TeardownTarget | undefined {
  const handle = findWorkspace(workspaceId)
  if (!handle) return undefined
  return {
    projectId: handle.projectId,
    workspaceId: handle.workspaceId,
    unitName: handle.jobName,
  }
}

export function listWorkspaces(projectId?: string): RuntimeHandle[] {
  return [...entries.values()]
    .filter((e) => projectId === undefined || e.marker.projectId === projectId)
    .map(toHandle)
}

/** See `WorkspaceDriver.count`. */
export function countWorkspaces(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const e of entries.values()) {
    if (!e.running) continue
    counts[e.marker.projectId] = (counts[e.marker.projectId] ?? 0) + 1
  }
  return counts
}

/** A pass's view of the runtime. `strayUnits` is always empty: the tmux
 *  server is the unit, so nothing can outlive it. */
export function createRuntimeSnapshot(resync = false): RuntimeSnapshot {
  const workspaces = listWorkspaces()
  return {
    resync,
    workspaces: () => Promise.resolve(workspaces),
    strayUnits: () => Promise.resolve<StrayUnit[]>([]),
  }
}

/** Write the marker atomically. */
export async function writeMarker(marker: WorkspaceMarker): Promise<void> {
  const file = markerPath(marker.projectId, marker.workspaceId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  // A torn marker would be skipped at recovery, leaving its tmux server
  // running untracked.
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(marker, null, 2))
  await fs.rename(tmp, file)
}

export async function removeMarker(projectId: string, workspaceId: string): Promise<void> {
  await fs.rm(containerlessStateDir(projectId, workspaceId), { recursive: true, force: true })
}

/**
 * Every marker on disk, read on server start. Walks the projects tree
 * directly, since recovery runs before any reconcile pass could supply the
 * project list.
 */
export async function readMarkers(): Promise<WorkspaceMarker[]> {
  const root = getProjectsDir()
  let projectIds: string[]
  try {
    projectIds = (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  const found: WorkspaceMarker[] = []
  for (const projectId of projectIds) {
    let ids: string[]
    try {
      ids = (await fs.readdir(path.join(root, projectId, 'sessions'), { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      continue
    }
    for (const id of ids) {
      try {
        const raw = await fs.readFile(markerPath(projectId, id), 'utf8')
        const marker = JSON.parse(raw) as WorkspaceMarker
        // Identity comes from the path, so a copied marker cannot claim to
        // be its original.
        found.push({ ...marker, projectId, workspaceId: id })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          serverLog(`[server] containerless: unreadable marker ${projectId}/${id}: ${String(err)}`)
        }
      }
    }
  }
  return found
}

/** Install a recovered workspace with the liveness the scan proved. */
export function restoreWorkspace(
  marker: WorkspaceMarker,
  running: boolean,
  deathCause: WorkspaceDeathCause,
): void {
  entries.set(marker.workspaceId, { marker, running, deathCause })
}

/** The workspace's recorded ssh-agent pid, for teardown. */
export function sshAgentPidOf(workspaceId: string): number | undefined {
  return entries.get(workspaceId)?.marker.sshAgentPid
}
