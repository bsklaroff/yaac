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

/** A drained `yaac-mama create`, with everything the substrate could resolve. */
export interface SpawnRequest {
  /** Correlates the answer back to the pod blocked at the proxy. */
  requestId: string
  /** The workspace that called. */
  callerWorkspaceId: string
  /** Its project — the new workspace is created in the caller's project. */
  callerProjectSlug: string
  /** The tool the caller itself runs, when the substrate labelled it. Second
   *  in the tool precedence, behind the request's own choice. */
  callerTool?: AgentTool
  /** The posture the caller itself runs in — the spawned workspace's default,
   *  and the most it may be granted. */
  callerPermissionMode: PermissionMode
  prompt: string
  tool?: AgentTool
  model?: string
  permissionMode?: PermissionMode
  /** `tui` or `acp`; unnamed is `tui`. */
  uiMode?: AgentMode
  /** Reference branch on `origin`; unnamed is the project's default. */
  branch?: string
  /** Sidebar group for the new workspace, by id or name — a name matching
   *  none is created, but only once nothing else here can refuse. */
  group?: string
  /** The new workspace's title; given, it is not auto-titled. */
  title?: string
}

/** What the server decided about one spawn request. */
export type SpawnDecision =
  | { ok: true; workspaceId: string }
  | { ok: false; error: string }

/** Prompt character limit — mirrors the proxy's check. */
export const SPAWN_MAX_PROMPT_CHARS = 10_000
/**
 * Cap on workspaces a single caller may have provisioning at once via spawn.
 * The proxy already bounds queue depth; this bounds fan-out across ticks
 * while creates (which take tens of seconds) are still in flight.
 */
export const SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE = 8

/** The ranking, as a refusal spells it: `bypass > … > plan = read-only`. */
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
 * Decide what a drained `yaac-mama create` means and start it.
 *
 * Every decision in a spawn is here rather than in the drain that queued it:
 * the tool precedence ends at the project's row, the fan-out cap is a policy,
 * and the id and its sidebar row are the server's to mint
 * (docs/layered-server.md). The drain contributed the one thing only
 * the substrate knows — which workspace called, in which project, running
 * what.
 *
 * The create is detached: the caller's pod is blocked at the proxy on the
 * minted id, not on the workspace being ready, and a failed create is a lost
 * fire that leaves a dismissable failed row behind.
 */
export async function decideSpawn(
  request: SpawnRequest,
  deps: SpawnPolicyDeps = {},
): Promise<SpawnDecision> {
  const fail = (error: string): SpawnDecision => ({ ok: false, error })

  // The settings arrive shape-checked (`yaac-mama`'s `createSettings`); the
  // prompt is the one thing only a create carries.
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
  const posture = agentPermissionMode(tool, uiMode, request.callerPermissionMode, request.permissionMode)
  if (!posture.ok) return posture
  // Last, so a spawn refused for anything above leaves no group behind.
  const groupId = request.group === undefined
    ? undefined
    : (await resolveGroup(request.callerProjectSlug, request.group, { create: true })).groupId

  const workspaceId = (deps.mintIdFn ?? (() => crypto.randomUUID()))()
  const projectSlug = request.callerProjectSlug
  inFlightByCaller.set(request.callerWorkspaceId, inFlight + 1)
  // Register the sidebar row before detaching, then run the create under the
  // same row lifecycle as a user-initiated create — the spawned workspace
  // shows provisioning progress in the webapp, and a spawn that fails at any
  // point, resolving its setup included, leaves a failed row (dismissable)
  // instead of vanishing silently. It also makes the minted id resolvable
  // the moment the caller has it: `queue --parent-workspace "$id"` right after the
  // create finds it here before the create has recorded its row.
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
    // The caller's posture, not the project's remembered one: a spawned
    // sibling is the caller's work carried on, and a `plan` or `manual`
    // inherited from someone's last webapp create would strand it at a
    // prompt no one will ever answer.
    permissionMode: posture.permissionMode,
    prompt: request.prompt,
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.branch !== undefined ? { branch: request.branch } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
    ...(request.title !== undefined ? { title: request.title } : {}),
    // An agent's choice is not the project's next default.
    rememberDefaults: false,
    // Never a spare: a claim hands back the spare's own id, and the caller
    // already holds this one — `id=$(yaac-mama create …)` is the scriptable
    // output, and every later command it feeds must find the workspace.
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
 * The posture something an agent starts runs in — a `yaac-mama create`d
 * workspace or a `yaac-mama queue`d one: the one it named, else the one it
 * inherits (the parent's, for a queued workspace; the caller's own
 * otherwise) — and never more permissive than the caller's.
 *
 * A named posture above the ceiling, or one the tool lacks under `mode`, is
 * refused rather than clamped: the caller said what it wanted, and launching
 * something else is the failure worth being loud about (the create is
 * detached, so this is the last point a refusal can reach it). An unnamed one
 * above the ceiling or the tool lacks steps down to the tool's most
 * permissive posture under both, since inheriting was a default rather than
 * a demand.
 */
export function agentPermissionMode(
  tool: AgentTool,
  mode: AgentMode,
  ceiling: PermissionMode,
  requested: PermissionMode | undefined,
  inherited: PermissionMode = ceiling,
): { ok: true; permissionMode: PermissionMode } | { ok: false; error: string } {
  // The row's column is plain text, so a row written by another build can
  // hold a posture this one does not rank. Refused, because it cannot be
  // compared: treating it as unranked would grant anything at all.
  if (!isRankedPermissionMode(ceiling)) {
    return { ok: false, error: `this workspace's recorded permission mode '${ceiling}' is not one this server knows` }
  }
  const where = mode === 'acp' ? ' under acp' : ''
  if (requested !== undefined) {
    // At most as permissive as the caller: otherwise an agent the user left in
    // `plan` could get its work done unrestrained by asking a sibling to do it.
    if (morePermissive(requested, ceiling)) {
      return {
        ok: false,
        error: `permission mode '${requested}' is more permissive than this workspace's own `
          + `('${ceiling}'); a workspace it starts may be granted at most that `
          + `(${HIERARCHY})`,
      }
    }
    return toolSupportsPermissionMode(tool, requested, mode)
      ? { ok: true, permissionMode: requested }
      : { ok: false, error: `${tool} has no '${requested}' permission mode${where}` }
  }
  const cap = isRankedPermissionMode(inherited) && morePermissive(ceiling, inherited) ? inherited : ceiling
  const stepped = nearestPermissionMode(tool, cap, mode)
  return stepped !== undefined
    ? { ok: true, permissionMode: stepped }
    : {
      ok: false,
      error: `${tool} has no permission mode${where} at or below this workspace's own ('${ceiling}')`,
    }
}

async function lastTool(projectSlug: string): Promise<AgentTool | undefined> {
  return (await getProjectRow(projectSlug))?.lastTool
}
