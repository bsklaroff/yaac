import crypto from 'node:crypto'
import { prepareStart } from './start'
import { prepareRestart } from './restart'
import { firstAgentSession, getProjectRow, getWorkspaceRow, listActiveAgentSessions } from '#db'
import type { Actor } from '#domain/access'
import { loadToolAuthEntry } from '#domain/auth'
import {
  agentPermissionMode,
  isRankedPermissionMode,
  launchablePermissionMode,
  morePermissive,
  type AgentMode,
  type AgentTool,
  type PermissionMode,
} from '@yaac/shared/types'
import { serverLog } from '#lib/log'
import { ServerError } from '@yaac/shared/errors'

/** A `yaac-mama create` request with its caller resolved. */
export interface SpawnRequest {
  /** Who the new workspace is started for: the calling workspace. */
  principal: Actor
  /** The workspace that called. */
  callerWorkspaceId: string
  /** The caller's project, where the new workspace is created. */
  callerProjectId: string
  /** The caller's own tool, if known; second in the tool precedence. */
  callerTool?: AgentTool
  /** The caller's permission mode: the default, and the most it may
   *  grant. */
  callerPermissionMode: PermissionMode
  /** The caller's own agent mode; the default `uiMode`. */
  callerMode: AgentMode
  prompt: string
  tool?: AgentTool
  model?: string
  permissionMode?: PermissionMode
  /** Unnamed is the project's remembered effort where the model has it,
   *  else the model's default. No ceiling: effort is not a restraint. */
  effort?: string
  /** `tui` or `acp`; unnamed is the caller's. */
  uiMode?: AgentMode
  /** Reference branch on `origin`; unnamed is the project's default. */
  branch?: string
  /** Group id or name; an unknown name is created, but only after every
   *  other check passes. */
  group?: string
  /** The new workspace's title; given, it is not auto-titled. */
  title?: string
  /** Minutes until the server stops it. No ceiling: a timeout only
   *  restrains. */
  timeout?: number
}

/** What the server decided about one spawn request. */
export type SpawnDecision =
  | { ok: true; workspaceId: string }
  | { ok: false; error: string }

/** Most workspaces one caller may have provisioning at once, counting
 *  what it created and what it restarted. */
export const SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE = 8

/** callerWorkspaceId → number of its creates and restarts still provisioning. */
const inFlightByCaller = new Map<string, number>()

/**
 * Take one of the caller's launch slots, returning what gives it back, or
 * undefined when all are taken. Taken before any await, so concurrent
 * requests cannot all pass the check.
 */
function reserveLaunch(caller: string): (() => void) | undefined {
  const inFlight = inFlightByCaller.get(caller) ?? 0
  if (inFlight >= SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE) return undefined
  inFlightByCaller.set(caller, inFlight + 1)
  return () => {
    const n = (inFlightByCaller.get(caller) ?? 1) - 1
    if (n <= 0) inFlightByCaller.delete(caller)
    else inFlightByCaller.set(caller, n)
  }
}

const TOO_MANY_LAUNCHES = `too many workspaces starting at once (max ${SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE} provisioning)`

/**
 * Validate a `yaac-mama create`, pick its tool and permission mode, and start
 * it detached. Returns the new id once its settings have checked out; a
 * create that fails after that leaves a dismissable failed row.
 */
export async function decideSpawn(request: SpawnRequest): Promise<SpawnDecision> {
  const fail = (error: string): SpawnDecision => ({ ok: false, error })

  // Settings were checked by `createSettings`, and the prompt's length by
  // the route.
  if (request.prompt.trim().length === 0) return fail('prompt must not be empty')

  const caller = request.callerWorkspaceId
  // A refusal below gives the slot back; a launch, once it settles.
  const release = reserveLaunch(caller)
  if (release === undefined) return fail(TOO_MANY_LAUNCHES)
  const workspaceId = crypto.randomUUID()
  const projectId = request.callerProjectId
  let run: Awaited<ReturnType<typeof prepareStart>>
  try {
    const admitted = await admit(request)
    if (!admitted.ok) {
      release()
      return admitted
    }
    // Checked here, the last point the caller can see a refusal (a named
    // effort the model lacks, say): the create itself runs detached.
    run = await prepareStart(request.principal, {
      projectId,
      workspaceId,
      tool: admitted.tool,
      mode: request.uiMode ?? request.callerMode,
      // Not the project's remembered mode, which could strand the agent at a
      // prompt nobody answers.
      permissionMode: admitted.permissionMode,
      prompt: request.prompt,
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.effort !== undefined ? { effort: request.effort } : {}),
      ...(request.branch !== undefined ? { branch: request.branch } : {}),
      ...(request.group !== undefined ? { group: request.group } : {}),
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.timeout !== undefined ? { deadline: new Date(Date.now() + request.timeout * 60_000) } : {}),
      rememberDefaults: false,
      // The caller gets this id; a spare has its own.
      claimSpare: false,
      draft: {},
    })
  } catch (err) {
    release()
    if (err instanceof ServerError && err.code === 'VALIDATION') return fail(err.message)
    throw err
  }
  void run().then(
    (created) => serverLog(`[spawn] ${caller.slice(0, 8)}... spawned workspace ${created.workspaceId.slice(0, 8)}... in ${projectId}`),
    (err: unknown) => serverLog(`[spawn] workspace create for ${caller.slice(0, 8)}... failed: ${String(err)}`),
  ).finally(release)

  return { ok: true, workspaceId }
}

/** A `yaac-mama restart` request with its caller resolved. */
export interface RestartRequest {
  /** Who the restart runs for: the calling workspace. */
  principal: Actor
  callerWorkspaceId: string
  callerProjectId: string
  /** The most permissive mode the restarted workspace may run in. */
  callerPermissionMode: PermissionMode
  /** The workspace to restart, an exact id in the caller's project. */
  workspaceId: string
  /** Minutes from the restart until the server stops it. A workspace that
   *  had a timeout keeps its length, or this if shorter. */
  timeout?: number
}

/** What the server decided about one restart request: how many
 *  conversations it brings back, or why it is refused. */
export type RestartDecision =
  | { ok: true; conversations: number }
  | { ok: false; error: string }

/**
 * Admit a `yaac-mama restart` and run it detached. Only a stopped workspace
 * is restarted, since tearing down a running one would end whatever turn its
 * agent is in. Each conversation relaunches in the recorded permission mode,
 * or the nearest its tool has (`launchablePermissionMode`, which for pi is
 * always `bypass`), so one that would come back more permissive than the
 * caller is refused, as a create asking for that mode would be. So is one
 * whose tools the project owner is no longer signed in to. A restart counts
 * against the caller's in-flight cap like a create.
 */
export async function decideRestart(request: RestartRequest): Promise<RestartDecision> {
  const fail = (error: string): RestartDecision => ({ ok: false, error })
  const { callerProjectId: projectId, workspaceId } = request
  const short = workspaceId.slice(0, 8)
  if (workspaceId === request.callerWorkspaceId) return fail('restart cannot restart this workspace itself')
  const row = await getWorkspaceRow(projectId, workspaceId)
  if (row?.stoppedAt === undefined) return fail(`workspace ${short} is not stopped`)

  const ceiling = request.callerPermissionMode
  const recorded = row.permissionMode
  if (!isRankedPermissionMode(ceiling) || !isRankedPermissionMode(recorded)) {
    return fail(`cannot tell whether ${short}'s permission mode '${recorded}' is within `
      + `this workspace's own ('${ceiling}'), so it cannot be restarted`)
  }

  const active = await listActiveAgentSessions(projectId, workspaceId)
  const tools = active.length > 0
    ? [...new Set(active.map((a) => a.tool))]
    : [(await firstAgentSession(projectId, workspaceId))?.tool ?? 'claude']
  const beyond = `more than this workspace's own ('${ceiling}'); only one at or below it can be restarted`
  for (const tool of tools) {
    const launched = launchablePermissionMode(tool, recorded)
    if (!morePermissive(launched, ceiling)) continue
    return fail(launched === recorded
      ? `${short} runs in permission mode '${recorded}', ${beyond}`
      : `${short}'s ${tool} conversation would come back in permission mode '${launched}', the nearest `
        + `${tool} has to '${recorded}', ${beyond}`)
  }
  const owner = (await getProjectRow(projectId))?.owner
  for (const tool of tools) {
    if (owner === undefined || !await loadToolAuthEntry(owner, tool)) {
      return fail(`${tool} is not signed in for this project's owner, so ${short}'s agent could not `
        + 'authenticate (see `yaac-mama models`)')
    }
  }

  // A timeout only the user may lift: one the workspace had comes back at
  // the same length, or shorter if the caller asks.
  const previous = row.timeoutMinutes
  const timeout = previous === undefined ? request.timeout : Math.min(request.timeout ?? previous, previous)

  const caller = request.callerWorkspaceId
  const release = reserveLaunch(caller)
  if (release === undefined) return fail(TOO_MANY_LAUNCHES)
  let run: Awaited<ReturnType<typeof prepareRestart>>
  try {
    run = await prepareRestart(request.principal, workspaceId, {
      stoppedOnly: true,
      ...(timeout !== undefined ? { deadline: new Date(Date.now() + timeout * 60_000) } : {}),
    })
  } catch (err) {
    release()
    if (err instanceof ServerError && (err.code === 'CONFLICT' || err.code === 'VALIDATION')) return fail(err.message)
    throw err
  }
  void run().then(
    () => serverLog(`[spawn] ${caller.slice(0, 8)}... restarted workspace ${short}... in ${projectId}`),
    (err: unknown) => serverLog(`[spawn] restart of ${short}... for ${caller.slice(0, 8)}... failed: ${String(err)}`),
  ).finally(release)
  return { ok: true, conversations: Math.max(1, active.length) }
}

/** What `admit` decided: the spawn's tool and posture, or why it is refused. */
type Admission =
  | { ok: true; tool: AgentTool; permissionMode: PermissionMode }
  | { ok: false; error: string }

/**
 * Pick a spawn's tool, refuse one the project owner has not signed in to
 * (the spawn runs on their credentials, so its agent could not
 * authenticate), and settle its posture.
 */
async function admit(request: SpawnRequest): Promise<Admission> {
  const project = await getProjectRow(request.callerProjectId)
  // Tool precedence: explicit request > the caller's own tool > the agent
  // the project was last created with > claude.
  const tool = request.tool ?? request.callerTool ?? project?.lastTool ?? 'claude'
  if (project === undefined || !await loadToolAuthEntry(project.owner, tool)) {
    return { ok: false, error: `${tool} is not signed in for this project's owner (see \`yaac-mama models\`)` }
  }
  const posture = agentPermissionMode(tool, request.callerPermissionMode, request.permissionMode)
  return posture.ok ? { ok: true, tool, permissionMode: posture.permissionMode } : posture
}
