import crypto from 'node:crypto'
import { registerProvisioning, runProvisioned } from './provisioning'
import { resolveGroup } from './groups'
import { startWorkspace } from './start'
import { getProjectRow } from '#db'
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

/** A `yaac-mama create` request with its caller resolved. */
export interface SpawnRequest {
  /** Identifies the request in logs and answers. */
  requestId: string
  /** The workspace that called. */
  callerWorkspaceId: string
  /** The caller's project, where the new workspace is created. */
  callerProjectSlug: string
  /** The caller's own tool, if known; second in the tool precedence. */
  callerTool?: AgentTool
  /** The caller's permission mode: the default, and the most it may
   *  grant. */
  callerPermissionMode: PermissionMode
  prompt: string
  tool?: AgentTool
  model?: string
  permissionMode?: PermissionMode
  /** `tui` or `acp`; unnamed is `tui`. */
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
  lastToolFn?: (projectSlug: string) => Promise<AgentTool | undefined>
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

  const inFlight = inFlightByCaller.get(request.callerWorkspaceId) ?? 0
  if (inFlight >= SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE) {
    return fail(`too many concurrent spawns (max ${SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE} provisioning at once)`)
  }

  // Tool precedence: explicit request > the caller's own tool > the agent
  // the project was last created with > claude.
  const tool = request.tool
    ?? request.callerTool
    ?? await (deps.lastToolFn ?? lastTool)(request.callerProjectSlug)
    ?? 'claude'
  const uiMode = request.uiMode ?? 'tui'
  const posture = agentPermissionMode(tool, request.callerPermissionMode, request.permissionMode)
  if (!posture.ok) return posture
  // Last, so a refused spawn creates no group.
  const groupId = request.group === undefined
    ? undefined
    : (await resolveGroup(request.callerProjectSlug, request.group, { create: true })).groupId

  const workspaceId = (deps.mintIdFn ?? (() => crypto.randomUUID()))()
  const projectSlug = request.callerProjectSlug
  inFlightByCaller.set(request.callerWorkspaceId, inFlight + 1)
  // Register the provisioning row before detaching: it shows progress and
  // failures, and makes the id usable as a queue parent right away.
  registerProvisioning({
    workspaceId: workspaceId,
    projectSlug,
    tool,
    kind: 'create',
    ...(groupId !== undefined ? { groupId } : {}),
    ...(request.branch !== undefined ? { branch: request.branch } : {}),
  })
  void runProvisioned(workspaceId, (onProgress) => startWorkspace({
    projectSlug,
    workspaceId: workspaceId,
    tool,
    mode: uiMode,
    // Not the project's remembered mode, which could strand the agent at a
    // prompt nobody answers.
    permissionMode: posture.permissionMode,
    prompt: request.prompt,
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.branch !== undefined ? { branch: request.branch } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
    ...(request.title !== undefined ? { title: request.title } : {}),
    rememberDefaults: false,
    // The caller already has this id; a spare has its own.
    claimSpare: false,
  }, onProgress)).then(
    (created) => serverLog(`[spawn] ${request.callerWorkspaceId.slice(0, 8)}... spawned workspace ${created.workspaceId.slice(0, 8)}... in ${projectSlug}`),
    (err: unknown) => serverLog(`[spawn] workspace create for ${request.callerWorkspaceId.slice(0, 8)}... failed: ${String(err)}`),
  ).finally(() => {
    const n = (inFlightByCaller.get(request.callerWorkspaceId) ?? 1) - 1
    if (n <= 0) inFlightByCaller.delete(request.callerWorkspaceId)
    else inFlightByCaller.set(request.callerWorkspaceId, n)
  })

  return { ok: true, workspaceId }
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

async function lastTool(projectSlug: string): Promise<AgentTool | undefined> {
  return (await getProjectRow(projectSlug))?.lastTool
}
