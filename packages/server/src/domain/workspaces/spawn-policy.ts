import crypto from 'node:crypto'
import { prepareStart } from './start'
import { getProjectRow } from '#db'
import type { Actor } from '#domain/access'
import { loadToolAuthEntry } from '#domain/auth'
import {
  agentPermissionMode,
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
}

/** What the server decided about one spawn request. */
export type SpawnDecision =
  | { ok: true; workspaceId: string }
  | { ok: false; error: string }

/** Most spawned workspaces one caller may have provisioning at once. */
export const SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE = 8

/** callerWorkspaceId → number of spawn-initiated creates still provisioning. */
const inFlightByCaller = new Map<string, number>()

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
  const inFlight = inFlightByCaller.get(caller) ?? 0
  if (inFlight >= SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE) {
    return fail(`too many concurrent spawns (max ${SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE} provisioning at once)`)
  }
  // Reserved before any await, so concurrent requests cannot all pass the
  // check. A refusal below gives the slot back; a launch, once it settles.
  inFlightByCaller.set(caller, inFlight + 1)
  const release = (): void => {
    const n = (inFlightByCaller.get(caller) ?? 1) - 1
    if (n <= 0) inFlightByCaller.delete(caller)
    else inFlightByCaller.set(caller, n)
  }
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
