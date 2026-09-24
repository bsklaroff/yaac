import crypto from 'node:crypto'
import { registerProvisioning, runProvisioned } from './provisioning'
import { createWorktree } from './create'
import { getProjectRow } from '#db'
import {
  AGENT_MODES,
  AGENT_TOOLS,
  MODEL_RE,
  PERMISSION_MODES,
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
  /** The worktree that called. */
  callerWorkspaceId: string
  /** Its project — the new worktree is created in the caller's project. */
  callerProjectSlug: string
  /** The tool the caller itself runs, when the substrate labelled it. Second
   *  in the tool precedence, behind the request's own choice. */
  callerTool?: AgentTool
  /** The posture the caller itself runs in — the spawned worktree's default,
   *  and the most it may be granted. */
  callerPermissionMode: PermissionMode
  prompt: string
  tool?: string
  model?: string
  permissionMode?: string
  /** `tui` or `acp`; unnamed is `tui`. */
  mode?: string
  /** Reference branch on `origin`; unnamed is the project's default. */
  branch?: string
  /** Sidebar group for the new worktree — already resolved to an id by the
   *  caller, since a group named by a request may have to be created first. */
  groupId?: string
}

/** What the server decided about one spawn request. */
export type SpawnDecision =
  | { ok: true; workspaceId: string }
  | { ok: false; error: string }

/** Prompt character limit — mirrors the proxy's check. */
export const SPAWN_MAX_PROMPT_CHARS = 10_000
/**
 * Cap on worktrees a single caller may have provisioning at once via spawn.
 * The proxy already bounds queue depth; this bounds fan-out across ticks
 * while creates (which take tens of seconds) are still in flight.
 */
export const SPAWN_MAX_IN_FLIGHT_PER_WORKTREE = 8

/**
 * Postures ranked from most to least permissive — a Record, so a new
 * `PermissionMode` member cannot go unranked. A spawned worktree may run at most
 * as permissively as its caller: otherwise an agent the user left in `plan`
 * could get its work done unrestrained by asking for a sibling to do it.
 */
const RANK: Record<PermissionMode, number> = { bypass: 0, auto: 1, 'accept-edits': 2, manual: 3, plan: 4 }
const PERMISSIVENESS = (Object.keys(RANK) as PermissionMode[]).sort((a, b) => RANK[a] - RANK[b])

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
 * the substrate knows — which worktree called, in which project, running
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

  // Re-validate what the proxy already checked — defense in depth, and the
  // server is the side that owns what a valid request is.
  if (request.prompt.trim().length === 0) return fail('prompt must not be empty')
  if (request.prompt.length > SPAWN_MAX_PROMPT_CHARS) {
    return fail(`prompt exceeds ${SPAWN_MAX_PROMPT_CHARS} characters`)
  }
  if (request.tool !== undefined && !(AGENT_TOOLS as readonly string[]).includes(request.tool)) {
    return fail(`invalid tool '${request.tool}' (expected one of: ${AGENT_TOOLS.join(', ')})`)
  }
  if (request.model !== undefined && !MODEL_RE.test(request.model)) {
    return fail(`invalid model '${request.model}'`)
  }
  if (request.mode !== undefined && !(AGENT_MODES as readonly string[]).includes(request.mode)) {
    return fail(`invalid mode '${request.mode}' (expected one of: ${AGENT_MODES.join(', ')})`)
  }
  if (request.permissionMode !== undefined
    && !(PERMISSION_MODES as readonly string[]).includes(request.permissionMode)) {
    return fail(`invalid permission mode '${request.permissionMode}' (expected one of: ${PERMISSIVENESS.join(', ')})`)
  }
  if (request.branch !== undefined && request.branch.trim() === '') {
    return fail('branch must not be empty')
  }

  const inFlight = inFlightByCaller.get(request.callerWorkspaceId) ?? 0
  if (inFlight >= SPAWN_MAX_IN_FLIGHT_PER_WORKTREE) {
    return fail(`too many concurrent spawns (max ${SPAWN_MAX_IN_FLIGHT_PER_WORKTREE} provisioning at once)`)
  }

  // Tool precedence: explicit request > the caller's own tool > the agent
  // the project was last created with > claude.
  const tool = (request.tool as AgentTool | undefined)
    ?? request.callerTool
    ?? await (deps.lastToolFn ?? lastTool)(request.callerProjectSlug)
    ?? 'claude'
  const mode = (request.mode ?? 'tui') as AgentMode
  const posture = spawnPermissionMode(
    tool, mode, request.callerPermissionMode, request.permissionMode as PermissionMode | undefined,
  )
  if (!posture.ok) return posture

  const workspaceId = (deps.mintIdFn ?? (() => crypto.randomUUID()))()
  const projectSlug = request.callerProjectSlug
  inFlightByCaller.set(request.callerWorkspaceId, inFlight + 1)
  // Register the sidebar row before detaching, then run the create under the
  // same row lifecycle as a user-initiated create — the spawned worktree shows
  // provisioning progress in the webapp and a failed spawn leaves a failed
  // row (dismissable) instead of vanishing silently.
  registerProvisioning({
    worktreeId: workspaceId,
    projectSlug,
    tool,
    kind: 'create',
    ...(request.groupId !== undefined ? { groupId: request.groupId } : {}),
  })
  void runProvisioned(workspaceId, (onProgress) =>
    createWorktree(projectSlug, {
      tool,
      initialPrompt: request.prompt,
      worktreeId: workspaceId,
      model: request.model,
      mode,
      // The caller's posture, not the project's remembered one: a spawned
      // sibling is the caller's work carried on, and a `plan` or `manual`
      // inherited from someone's last webapp create would strand it at a
      // prompt no one will ever answer.
      permissionMode: posture.permissionMode,
      ...(request.branch !== undefined ? { branch: request.branch } : {}),
      ...(request.groupId !== undefined ? { groupId: request.groupId } : {}),
      onProgress,
    })).then(
    () => serverLog(`[spawn] ${request.callerWorkspaceId.slice(0, 8)}... spawned worktree ${workspaceId.slice(0, 8)}... in ${projectSlug}`),
    (err: unknown) => serverLog(`[spawn] worktree create for ${request.callerWorkspaceId.slice(0, 8)}... failed: ${String(err)}`),
  ).finally(() => {
    const n = (inFlightByCaller.get(request.callerWorkspaceId) ?? 1) - 1
    if (n <= 0) inFlightByCaller.delete(request.callerWorkspaceId)
    else inFlightByCaller.set(request.callerWorkspaceId, n)
  })

  return { ok: true, workspaceId }
}

/**
 * The posture a spawn launches in: the one it named, else the caller's own —
 * and never more permissive than the caller's.
 *
 * A named posture above the ceiling, or one the tool lacks under `mode`, is
 * refused rather than clamped: the caller said what it wanted, and launching
 * something else is the failure worth being loud about (the create is
 * detached, so this is the last point a refusal can reach it). An unnamed one
 * the tool lacks steps down to the tool's most permissive posture under the
 * ceiling, since inheriting was a default rather than a demand.
 */
function spawnPermissionMode(
  tool: AgentTool,
  mode: AgentMode,
  ceiling: PermissionMode,
  requested: PermissionMode | undefined,
): { ok: true; permissionMode: PermissionMode } | { ok: false; error: string } {
  // The row's column is plain text, so a row written by another build can
  // hold a posture this one does not rank. Refused, because it cannot be
  // compared: treating it as unranked would grant anything at all.
  if (!Object.hasOwn(RANK, ceiling)) {
    return { ok: false, error: `this worktree's recorded permission mode '${ceiling}' is not one this server knows` }
  }
  const where = mode === 'acp' ? ' under acp' : ''
  if (requested !== undefined) {
    if (RANK[requested] < RANK[ceiling]) {
      return {
        ok: false,
        error: `permission mode '${requested}' is more permissive than this worktree's own `
          + `('${ceiling}'); a spawned worktree may be granted at most that `
          + `(${PERMISSIVENESS.join(' > ')})`,
      }
    }
    return toolSupportsPermissionMode(tool, requested, mode)
      ? { ok: true, permissionMode: requested }
      : { ok: false, error: `${tool} has no '${requested}' permission mode${where}` }
  }
  const inherited = PERMISSIVENESS.filter((m) => RANK[m] >= RANK[ceiling])
    .find((m) => toolSupportsPermissionMode(tool, m, mode))
  return inherited !== undefined
    ? { ok: true, permissionMode: inherited }
    : {
      ok: false,
      error: `${tool} has no permission mode${where} at or below this worktree's own ('${ceiling}')`,
    }
}

async function lastTool(projectSlug: string): Promise<AgentTool | undefined> {
  return (await getProjectRow(projectSlug))?.lastTool
}
