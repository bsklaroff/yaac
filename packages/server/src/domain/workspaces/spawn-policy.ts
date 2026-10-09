import crypto from 'node:crypto'
import { registerProvisioning, runProvisioned } from './provisioning'
import { resolveGroup } from './groups'
import { startWorkspace } from './start'
import { resolveCreate } from './create'
import { getProjectRow } from '#db'
import type { Actor } from '#domain/access'
import { loadToolAuthEntry } from '#domain/auth'
import {
  PERMISSION_MODES,
  isRankedPermissionMode,
  morePermissive,
  nearestPermissionMode,
  toolSupportsPermissionMode,
  type AgentMode,
  type AgentTool,
  type PermissionMode,
} from '@yaac/shared/types'
import { serverLog } from '#log'
import { ServerError } from '@yaac/shared/errors'

/** A `yaac-mama create` request with its caller resolved. */
export interface SpawnRequest {
  /** Identifies the request in logs and answers. */
  requestId: string
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
  /** The caller's own agent mode, if recorded; the default `uiMode`. */
  callerMode?: AgentMode
  prompt: string
  tool?: AgentTool
  model?: string
  permissionMode?: PermissionMode
  /** Unnamed is the project's remembered effort where the model has it,
   *  else the model's default. No ceiling: effort is not a restraint. */
  effort?: string
  /** `tui` or `acp`; unnamed is the caller's, else the create default. */
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

/** Prompt character limit, as the `/workspace/mama` route enforces. */
export const SPAWN_MAX_PROMPT_CHARS = 10_000
/** Most spawned workspaces one caller may have provisioning at once. */
export const SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE = 8

/** The ranking as shown in refusals: `bypass > … > plan = read-only`. */
const HIERARCHY = PERMISSION_MODES.map((m, i) =>
  i === 0 ? m : `${morePermissive(PERMISSION_MODES[i - 1], m) ? '>' : '='} ${m}`).join(' ')

/** callerWorkspaceId → number of spawn-initiated creates still provisioning. */
const inFlightByCaller = new Map<string, number>()

export interface SpawnPolicyDeps {
  /** Injected for tests — the agent the project was last created with. */
  lastToolFn?: (projectId: string) => Promise<AgentTool | undefined>
  mintIdFn?: () => string
}

/**
 * Validate a `yaac-mama create`, pick its tool and permission mode, and start
 * it detached. Returns the new id immediately; a failed create leaves a
 * dismissable failed row.
 */
export async function decideSpawn(
  request: SpawnRequest,
  deps: SpawnPolicyDeps = {},
): Promise<SpawnDecision> {
  const fail = (error: string): SpawnDecision => ({ ok: false, error })

  // Settings were checked by `createSettings`; the prompt is checked here.
  if (request.prompt.trim().length === 0) return fail('prompt must not be empty')
  if (request.prompt.length > SPAWN_MAX_PROMPT_CHARS) {
    return fail(`prompt exceeds ${SPAWN_MAX_PROMPT_CHARS} characters`)
  }

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
  let admitted: Admission
  try {
    admitted = await admit(request, deps)
  } catch (err) {
    release()
    throw err
  }
  if (!admitted.ok) {
    release()
    return admitted
  }
  const { tool, uiMode, permissionMode, groupId } = admitted

  const workspaceId = (deps.mintIdFn ?? (() => crypto.randomUUID()))()
  const projectId = request.callerProjectId
  // Register the provisioning row before detaching: it shows progress and
  // failures, and makes the id usable as a queue parent right away.
  registerProvisioning({
    workspaceId: workspaceId,
    projectId,
    tool,
    kind: 'create',
    ...(groupId !== undefined ? { groupId } : {}),
    ...(request.branch !== undefined ? { branch: request.branch } : {}),
  })
  void runProvisioned(workspaceId, (onProgress) => startWorkspace(request.principal, {
    projectId,
    workspaceId: workspaceId,
    tool,
    ...(uiMode !== undefined ? { mode: uiMode } : {}),
    // Not the project's remembered mode, which could strand the agent at a
    // prompt nobody answers.
    permissionMode,
    prompt: request.prompt,
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
    ...(request.branch !== undefined ? { branch: request.branch } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
    ...(request.title !== undefined ? { title: request.title } : {}),
    rememberDefaults: false,
    // The caller already has this id; a spare has its own.
    claimSpare: false,
    draft: {},
  }, onProgress)).then(
    (created) => serverLog(`[spawn] ${request.callerWorkspaceId.slice(0, 8)}... spawned workspace ${created.workspaceId.slice(0, 8)}... in ${projectId}`),
    (err: unknown) => serverLog(`[spawn] workspace create for ${request.callerWorkspaceId.slice(0, 8)}... failed: ${String(err)}`),
  ).finally(release)

  return { ok: true, workspaceId }
}

/** What `admit` decided: the spawn's settings, or why it is refused. */
type Admission =
  | { ok: true; tool: AgentTool; uiMode?: AgentMode; permissionMode: PermissionMode; groupId?: string }
  | { ok: false; error: string }

/**
 * The checks a spawn passes once its in-flight slot is reserved: pick its
 * tool, refuse one the project owner has not signed in to (the spawn runs on
 * their credentials, so its agent could not authenticate), settle its
 * posture, check a named effort against its model, and resolve its group,
 * last so a refused spawn creates none.
 */
async function admit(request: SpawnRequest, deps: SpawnPolicyDeps): Promise<Admission> {
  // Tool precedence: explicit request > the caller's own tool > the agent
  // the project was last created with > claude.
  const tool = request.tool
    ?? request.callerTool
    ?? await (deps.lastToolFn ?? lastTool)(request.callerProjectId)
    ?? 'claude'
  const owner = (await getProjectRow(request.callerProjectId))?.owner
  if (owner === undefined || !await loadToolAuthEntry(owner, tool)) {
    return { ok: false, error: `${tool} is not signed in for this project's owner (see \`yaac-mama models\`)` }
  }
  const posture = agentPermissionMode(tool, request.callerPermissionMode, request.permissionMode)
  if (!posture.ok) return posture
  // A named effort the model lacks is refused here, the last point the
  // caller can see a refusal: the create itself runs detached.
  if (request.effort !== undefined) {
    try {
      await resolveCreate(request.callerProjectId, {
        tool,
        effort: request.effort,
        ...(request.model !== undefined ? { model: request.model } : {}),
      })
    } catch (err) {
      if (err instanceof ServerError && err.code === 'VALIDATION') return { ok: false, error: err.message }
      throw err
    }
  }
  const groupId = request.group === undefined
    ? undefined
    : (await resolveGroup(request.callerProjectId, request.group, { create: true })).groupId
  const uiMode = request.uiMode ?? request.callerMode
  return {
    ok: true,
    tool,
    permissionMode: posture.permissionMode,
    ...(uiMode !== undefined ? { uiMode } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
  }
}

/**
 * The permission mode for a workspace an agent creates or queues: the one it
 * named, else the inherited one (the queue parent's, or the caller's), never
 * more permissive than the caller's.
 *
 * A named mode above the ceiling or unsupported by the tool is refused. An
 * inherited one steps down to the nearest supported mode within both limits.
 */
export function agentPermissionMode(
  tool: AgentTool,
  ceiling: PermissionMode,
  requested: PermissionMode | undefined,
  inherited: PermissionMode = ceiling,
): { ok: true; permissionMode: PermissionMode } | { ok: false; error: string } {
  // A row from another build may hold an unknown mode, which cannot be
  // compared safely.
  if (!isRankedPermissionMode(ceiling)) {
    return { ok: false, error: `this workspace's recorded permission mode '${ceiling}' is not one this server knows` }
  }
  if (requested !== undefined) {
    // Otherwise an agent in `plan` could escape it via a sibling.
    if (morePermissive(requested, ceiling)) {
      return {
        ok: false,
        error: `permission mode '${requested}' is more permissive than this workspace's own `
          + `('${ceiling}'); a workspace it starts may be granted at most that `
          + `(${HIERARCHY})`,
      }
    }
    return toolSupportsPermissionMode(tool, requested)
      ? { ok: true, permissionMode: requested }
      : { ok: false, error: `${tool} has no '${requested}' permission mode` }
  }
  const cap = isRankedPermissionMode(inherited) && morePermissive(ceiling, inherited) ? inherited : ceiling
  const stepped = nearestPermissionMode(tool, cap)
  return stepped !== undefined
    ? { ok: true, permissionMode: stepped }
    : {
      ok: false,
      error: `${tool} has no permission mode at or below this workspace's own ('${ceiling}')`,
    }
}

async function lastTool(projectId: string): Promise<AgentTool | undefined> {
  return (await getProjectRow(projectId))?.lastTool
}
