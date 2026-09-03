import fs from 'node:fs/promises'
import path from 'node:path'
import { getProjectsDir } from '@yaac/shared/paths'
import { serverLog } from '#log'
import { containerlessJobName, markerPath, workspaceStateDir } from './paths'
import type {
  AgentMode,
  AgentTool,
  WorktreeDeathCause,
} from '@yaac/shared/types'
import type { RuntimeHandle, RuntimeSnapshot, StrayUnit, TeardownTarget } from '#drivers/contract'

/**
 * What this driver knows about the workspaces it is holding.
 *
 * The cluster driver reads this from the apiserver, which is a durable
 * record kept by something other than the server. Nothing on a bare host
 * plays that role, so it is kept twice: a marker file per workspace, which
 * is what survives a server restart, and this in-memory table, which is
 * what answers reads without touching disk.
 *
 * A tmux server outliving the server that started it is the whole premise
 * of the containerless design — agents keep running across a `yaac server
 * restart` — so recovery is not an edge case here, it is the ordinary path.
 */

/** The durable half: what the marker file holds. Deliberately small — every
 *  field is something only the launch knew and nothing can re-derive. */
export interface WorkspaceMarker {
  projectSlug: string
  worktreeId: string
  tool: AgentTool
  declaredTool?: AgentTool
  mode: AgentMode
  prewarm: boolean
  createdAtMs: number
  /** The tmux server's pid at launch. The port scan starts from it, and it
   *  is advisory: pids are recycled, so it is only ever used alongside a
   *  liveness check that proves the socket still answers. */
  tmuxPid?: number
  /**
   * The ssh-agent started for this workspace, when its project authenticates
   * over SSH. Recorded because the agent holds a private key in memory and
   * must not outlive the worktree: teardown signals this, and a recovery
   * scan that finds the workspace dead sweeps it.
   *
   * Advisory in the same way `tmuxPid` is — a pid can be recycled — so it is
   * only ever signalled alongside evidence the workspace was actually
   * running.
   */
  sshAgentPid?: number
}

/** The in-memory half: the marker plus what observation has since decided. */
interface Entry {
  marker: WorkspaceMarker
  running: boolean
  deathCause: WorktreeDeathCause
  /** A teardown has started; it renders as terminating and is not a reaper
   *  target. */
  terminating: boolean
  /** The workspace's process environment, kept so `exec` runs commands with
   *  the same env the tmux server was started with. Lost on a restart, when
   *  the tmux server holds the real copy and an exec only needs to reach it. */
  env?: NodeJS.ProcessEnv
}

const entries = new Map<string, Entry>()

/** Forget everything — tests only; a live server's table is emptied by the
 *  teardowns that empty the host. */
export function _resetRegistryForTests(): void {
  entries.clear()
}

export function rememberWorkspace(marker: WorkspaceMarker, env?: NodeJS.ProcessEnv): RuntimeHandle {
  entries.set(marker.worktreeId, {
    marker,
    running: true,
    deathCause: { reason: 'pod-stopped' },
    terminating: false,
    ...(env !== undefined ? { env } : {}),
  })
  return handleFor(marker.worktreeId) as RuntimeHandle
}

export function forgetWorkspace(worktreeId: string): void {
  entries.delete(worktreeId)
}

export function markTerminating(worktreeId: string): void {
  const entry = entries.get(worktreeId)
  if (entry) entry.terminating = true
}

/**
 * Record what a liveness observation saw, answering whether it CHANGED
 * anything — the caller reports upward only on a real edge, so a poll or a
 * repeated stream error costs no snapshot.
 */
export function observeLiveness(
  worktreeId: string,
  running: boolean,
  deathCause: WorktreeDeathCause,
): boolean {
  const entry = entries.get(worktreeId)
  if (!entry) return false
  if (entry.running === running) return false
  entry.running = running
  entry.deathCause = deathCause
  return true
}

export function workspaceEnv(worktreeId: string): NodeJS.ProcessEnv | undefined {
  return entries.get(worktreeId)?.env
}

export function tmuxPidOf(worktreeId: string): number | undefined {
  return entries.get(worktreeId)?.marker.tmuxPid
}

export function claimWorkspaceTool(worktreeId: string, tool: AgentTool): boolean {
  const entry = entries.get(worktreeId)
  if (!entry?.marker.prewarm) return false
  entry.marker.prewarm = false
  entry.marker.tool = tool
  entry.marker.declaredTool = tool
  return true
}

function toHandle(entry: Entry): RuntimeHandle {
  const { marker } = entry
  return {
    workspaceId: marker.worktreeId,
    projectSlug: marker.projectSlug,
    jobName: containerlessJobName(marker.projectSlug, marker.worktreeId),
    tool: marker.tool,
    ...(marker.declaredTool !== undefined ? { declaredTool: marker.declaredTool } : {}),
    mode: marker.mode,
    running: entry.running,
    state: entry.running ? 'running' : 'failed',
    // Nothing labels a host process. Empty rather than invented: a label is
    // substrate vocabulary, and no caller above the driver reads these.
    labels: {},
    createdAtMs: marker.createdAtMs,
    prewarmed: marker.prewarm,
    terminating: entry.terminating,
    deathCause: entry.deathCause,
  }
}

function handleFor(worktreeId: string): RuntimeHandle | undefined {
  const entry = entries.get(worktreeId)
  return entry ? toHandle(entry) : undefined
}

/**
 * Resolve a workspace by id, id prefix, or handle — the same three forms
 * every caller of `find` may pass.
 */
export function findWorkspace(idOrName: string): RuntimeHandle | undefined {
  const direct = handleFor(idOrName)
  if (direct) return direct
  const matches = [...entries.values()].filter((e) =>
    e.marker.worktreeId.startsWith(idOrName)
    || containerlessJobName(e.marker.projectSlug, e.marker.worktreeId) === idOrName)
  // An ambiguous prefix resolves to nothing rather than to an arbitrary
  // one of the candidates.
  const only = matches[0]
  return matches.length === 1 && only ? toHandle(only) : undefined
}

export function findForTeardown(idOrName: string): TeardownTarget | undefined {
  const handle = findWorkspace(idOrName)
  if (!handle) return undefined
  return {
    projectSlug: handle.projectSlug,
    workspaceId: handle.workspaceId,
    unitName: handle.jobName,
  }
}

export function listWorkspaces(projectSlug?: string): RuntimeHandle[] {
  return [...entries.values()]
    .filter((e) => projectSlug === undefined || e.marker.projectSlug === projectSlug)
    .map(toHandle)
}

/** Live counts per project, spares EXCLUDED (see the contract). */
export function countWorkspaces(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const e of entries.values()) {
    if (e.marker.prewarm || !e.running) continue
    counts[e.marker.projectSlug] = (counts[e.marker.projectSlug] ?? 0) + 1
  }
  return counts
}

/** How many one project is running, spares INCLUDED (see the contract). */
export function countForProject(projectSlug: string): number {
  return [...entries.values()]
    .filter((e) => e.marker.projectSlug === projectSlug && e.running).length
}

/**
 * A pass's view of the runtime.
 *
 * `strayUnits` is always empty and always will be: a stray unit is a Job
 * outliving its pod, and here the tmux server IS the unit — when it is gone
 * there is nothing left holding anything, which the liveness edge already
 * reported.
 */
export function createRuntimeSnapshot(resync = false): RuntimeSnapshot {
  const workspaces = listWorkspaces()
  return {
    resync,
    workspaces: () => Promise.resolve(workspaces),
    strayUnits: () => Promise.resolve<StrayUnit[]>([]),
  }
}

/** Write the durable record. Best-effort at the call site's discretion —
 *  a marker that fails to write costs recovery after a restart, not the
 *  launch itself. */
export async function writeMarker(marker: WorkspaceMarker): Promise<void> {
  const file = markerPath(marker.projectSlug, marker.worktreeId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  // Written whole or not at all. A torn marker reads as unparseable, and
  // recovery rightly skips one of those rather than tearing down what it
  // cannot identify — which would leave a live tmux server that is never
  // recovered, never watched and never reaped, with its agents running on
  // invisibly while the row goes stopped.
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(marker, null, 2))
  await fs.rename(tmp, file)
}

export async function removeMarker(projectSlug: string, worktreeId: string): Promise<void> {
  await fs.rm(workspaceStateDir(projectSlug, worktreeId), { recursive: true, force: true })
}

/**
 * Every marker on disk — what a fresh server has instead of a listing from
 * the substrate.
 *
 * Reads the projects tree directly because nothing else can: which projects
 * exist is a row question the layers above own, and a driver is handed the
 * answer only inside a reconcile pass. Recovery runs before the first pass,
 * so it enumerates the same directories the markers were written into.
 */
export async function readMarkers(): Promise<WorkspaceMarker[]> {
  const root = getProjectsDir()
  let slugs: string[]
  try {
    slugs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  const found: WorkspaceMarker[] = []
  for (const slug of slugs) {
    let ids: string[]
    try {
      ids = (await fs.readdir(path.join(root, slug, 'sessions'), { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      continue
    }
    for (const id of ids) {
      try {
        const raw = await fs.readFile(markerPath(slug, id), 'utf8')
        const marker = JSON.parse(raw) as WorkspaceMarker
        // The path is the authority on identity, not the file's contents: a
        // marker copied along with a directory would otherwise claim to be
        // the workspace it was copied from.
        found.push({ ...marker, projectSlug: slug, worktreeId: id })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          serverLog(`[server] containerless: unreadable marker ${slug}/${id}: ${String(err)}`)
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
  deathCause: WorktreeDeathCause,
): void {
  entries.set(marker.worktreeId, { marker, running, deathCause, terminating: false })
}

/**
 * The ssh-agent pid a workspace's marker records, if it started one.
 *
 * Read by teardown, which has to end the process holding this worktree's
 * private key. Off the in-memory entry rather than the file so it answers
 * for a workspace recovered after a server restart too — `readMarkers`
 * repopulates the same entries.
 */
export function sshAgentPidOf(workspaceId: string): number | undefined {
  return entries.get(workspaceId)?.marker.sshAgentPid
}
