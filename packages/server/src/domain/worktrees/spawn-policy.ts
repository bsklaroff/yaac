import crypto from 'node:crypto'
import { registerProvisioning, runProvisioned } from './provisioning'
import { createWorktree } from './create'
import { getDefaultTool } from '#db'
import { AGENT_TOOLS, MODEL_RE, type AgentTool } from '@yaac/shared/types'
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
  prompt: string
  tool?: string
  model?: string
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
export const SPAWN_MAX_IN_FLIGHT_PER_SESSION = 8

/** callerWorkspaceId → number of spawn-initiated creates still provisioning. */
const inFlightByCaller = new Map<string, number>()

export interface SpawnPolicyDeps {
  /** Injected for tests — the configured default tool. */
  defaultToolFn?: () => Promise<AgentTool | undefined>
  mintIdFn?: () => string
}

/**
 * Decide what a drained `yaac-mama create` means and start it.
 *
 * Every decision in a spawn is here rather than in the drain that queued it:
 * the tool precedence ends at a preference row, the fan-out cap is a policy,
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

  const inFlight = inFlightByCaller.get(request.callerWorkspaceId) ?? 0
  if (inFlight >= SPAWN_MAX_IN_FLIGHT_PER_SESSION) {
    return fail(`too many concurrent spawns (max ${SPAWN_MAX_IN_FLIGHT_PER_SESSION} provisioning at once)`)
  }

  // Tool precedence: explicit request > the caller's own tool > the
  // configured default > claude.
  const tool = (request.tool as AgentTool | undefined)
    ?? request.callerTool
    ?? await (deps.defaultToolFn ?? getDefaultTool)()
    ?? 'claude'

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
      ...(request.groupId !== undefined ? { groupId: request.groupId } : {}),
      // No posture: createWorktree defaults it from the driver, deliberately
      // without consulting the project's remembered choice. A spawned sibling
      // is handed a prompt and left to work with nobody attached, so a `plan`
      // or `manual` inherited from someone's last webapp create would strand
      // it at a prompt no one will ever answer.
      onProgress,
    })).then(
    () => serverLog(`[spawn] ${request.callerWorkspaceId.slice(0, 8)}... spawned session ${workspaceId.slice(0, 8)}... in ${projectSlug}`),
    (err: unknown) => serverLog(`[spawn] session create for ${request.callerWorkspaceId.slice(0, 8)}... failed: ${String(err)}`),
  ).finally(() => {
    const n = (inFlightByCaller.get(request.callerWorkspaceId) ?? 1) - 1
    if (n <= 0) inFlightByCaller.delete(request.callerWorkspaceId)
    else inFlightByCaller.set(request.callerWorkspaceId, n)
  })

  return { ok: true, workspaceId }
}
