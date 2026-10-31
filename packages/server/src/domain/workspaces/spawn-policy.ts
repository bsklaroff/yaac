import crypto from 'node:crypto'
import { prepareStart } from './start'
import { prepareRestart } from './restart'
import { openSession } from './sessions'
import { resolveProjectWorkspace } from './resolve'
import { getProjectRow, getWorkspaceRow, listWorkspaceSessions } from '#db'
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
  /** A running workspace of the project to open the session in, by id or
   *  prefix, rather than a new workspace. */
  workspace?: string
  /** Start a new workspace with no session, which takes no prompt or agent
   *  settings. */
  noSession?: boolean
  /** An earlier conversation of the project to open the session on. */
  resume?: string
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

/** What the server decided about one spawn request: the workspace, and the
 *  session it opened in an existing one. */
export type SpawnDecision =
  | { ok: true; workspaceId: string; sessionId?: string }
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
 * it: a session in the running workspace `workspace` names, at once, else a
 * new workspace, detached. Returns the new workspace's id once its settings
 * have checked out; a create that fails after that leaves a dismissable
 * failed row.
 */
export async function decideSpawn(request: SpawnRequest): Promise<SpawnDecision> {
  const fail = (error: string): SpawnDecision => ({ ok: false, error })

  // Settings were checked by `createSettings`, and the prompt's length by
  // the route.
  if (request.noSession !== true && request.resume === undefined && request.prompt.trim().length === 0) {
    return fail('prompt must not be empty')
  }
  if (request.workspace !== undefined) return await spawnSession(request, request.workspace)
  if (request.resume !== undefined) return fail('--resume needs --workspace: a conversation resumes in the workspace that holds it')

  const caller = request.callerWorkspaceId
  // A refusal below gives the slot back; a launch, once it settles.
  const release = reserveLaunch(caller)
  if (release === undefined) return fail(TOO_MANY_LAUNCHES)
  const workspaceId = crypto.randomUUID()
  const projectId = request.callerProjectId
  let run: Awaited<ReturnType<typeof prepareStart>>
  try {
    const admitted = request.noSession === true ? undefined : await admit(request)
    if (admitted !== undefined && !admitted.ok) {
      release()
      return admitted
    }
    // Checked here, the last point the caller can see a refusal (a named
    // effort the model lacks, say): the create itself runs detached.
    run = await prepareStart(request.principal, {
      projectId,
      workspaceId,
      ...(admitted === undefined ? { noSession: true } : {
        tool: admitted.tool,
        mode: request.uiMode ?? request.callerMode,
        // Not the project's remembered mode, which could strand the agent at
        // a prompt nobody answers.
        permissionMode: admitted.permissionMode,
        prompt: request.prompt,
      }),
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
  /** Minutes from the restart until the server stops it, or null for no
   *  timeout. Omitted, a workspace that had a timeout keeps its length. */
  timeout?: number | null
}

/** What the server decided about one restart request, or why it is
 *  refused. */
export type RestartDecision =
  | { ok: true; sessions: number }
  | { ok: false; error: string }

/**
 * Admit a `yaac-mama restart` and run it detached. Only a stopped workspace
 * is restarted, since tearing down a running one would end whatever turn its
 * agent is in. Each session relaunches in its recorded permission mode, or
 * the nearest its tool has (`launchablePermissionMode`, which for pi is
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
  const sessions = await listWorkspaceSessions(workspaceId)
  const beyond = `more than this workspace's own ('${ceiling}'); only one at or below it can be restarted`
  for (const s of sessions) {
    if (!isRankedPermissionMode(ceiling) || !isRankedPermissionMode(s.permissionMode)) {
      return fail(`cannot tell whether ${short}'s permission mode '${s.permissionMode}' is within `
        + `this workspace's own ('${ceiling}'), so it cannot be restarted`)
    }
    const launched = launchablePermissionMode(s.tool, s.permissionMode)
    if (!morePermissive(launched, ceiling)) continue
    return fail(launched === s.permissionMode
      ? `${short}'s ${s.tool} session runs in permission mode '${s.permissionMode}', ${beyond}`
      : `${short}'s ${s.tool} session would come back in permission mode '${launched}', the nearest `
        + `${s.tool} has to '${s.permissionMode}', ${beyond}`)
  }
  const tools = [...new Set(sessions.map((s) => s.tool))]
  const owner = (await getProjectRow(projectId))?.owner
  for (const tool of tools) {
    if (owner === undefined || !await loadToolAuthEntry(owner, tool)) {
      return fail(`${tool} is not signed in for this project's owner, so ${short}'s agent could not `
        + 'authenticate (see `yaac-mama models`)')
    }
  }

  const timeout = request.timeout !== undefined ? request.timeout : row.timeoutMinutes

  const caller = request.callerWorkspaceId
  const release = reserveLaunch(caller)
  if (release === undefined) return fail(TOO_MANY_LAUNCHES)
  let run: Awaited<ReturnType<typeof prepareRestart>>
  try {
    run = await prepareRestart(request.principal, workspaceId, {
      stoppedOnly: true,
      ...(timeout != null ? { deadline: new Date(Date.now() + timeout * 60_000) } : {}),
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
  return { ok: true, sessions: sessions.length }
}

/** What `admit` decided: the spawn's tool and posture, or why it is refused. */
type Admission =
  | { ok: true; tool: AgentTool; permissionMode: PermissionMode }
  | { ok: false; error: string }

/**
 * Open a session in a running workspace of the caller's project, settled as
 * a new workspace's would be (`admit`). The caller's own workspace counts,
 * for an agent beside it on the same checkout.
 */
async function spawnSession(request: SpawnRequest, target: string): Promise<SpawnDecision> {
  const admitted = await admit(request)
  if (!admitted.ok) return admitted
  try {
    const workspaceId = await resolveProjectWorkspace(target, request.callerProjectId)
    const session = await openSession(request.principal, workspaceId, {
      tool: admitted.tool,
      mode: request.uiMode ?? request.callerMode,
      permissionMode: admitted.permissionMode,
      ...(request.prompt.trim() !== '' ? { prompt: request.prompt } : {}),
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.effort !== undefined ? { effort: request.effort } : {}),
      ...(request.resume !== undefined ? { resume: request.resume } : {}),
      ...(request.title !== undefined ? { title: request.title } : {}),
    })
    return { ok: true, workspaceId, sessionId: session.id }
  } catch (err) {
    if (err instanceof ServerError && ['VALIDATION', 'NOT_FOUND', 'CONFLICT'].includes(err.code)) {
      return { ok: false, error: err.message }
    }
    throw err
  }
}

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
