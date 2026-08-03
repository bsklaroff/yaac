/**
 * Reconcile step that services in-session `yaac-spawn` requests: the
 * egress proxy holds each session's `POST http://yaac.internal/spawn` open
 * in an in-memory queue; this step drains that queue over the control API,
 * starts one headless session per request in the CALLER's project (no
 * terminal, no NDJSON stream; progress surfaces only through the webapp's
 * provisioning row), and posts the minted session id back so the proxy
 * answers the waiting pod.
 *
 * A drain is a claim: a crash between drain and create loses the fire (the
 * pod's request 504s at the proxy TTL), never doubles it.
 */
import crypto from 'node:crypto'
import { AGENT_TOOLS, type AgentTool } from '@yaac/shared/types'
import {
  proxyClient,
  type PendingSpawn,
  type SpawnResultWire,
} from '#features/sessions/egress/proxy-client'
import { type SessionPod, type TickSnapshot, listSessionPods } from '#platform/k8s'
import { getDefaultTool } from '#features/projects'
import { registerProvisioning, runProvisioned } from '#features/sessions/provisioning'
import { createSession, type SessionCreateOptions, type SessionCreateResult } from '#features/sessions/create'
import { MODEL_RE } from '#features/sessions/agent-command'
import { serverLog } from '#log'

/** Prompt character limit — mirrors the proxy's check. */
export const SPAWN_MAX_PROMPT_CHARS = 10_000
/**
 * Cap on sessions a single caller may have provisioning at once via spawn.
 * The proxy already bounds queue depth; this bounds fan-out across ticks
 * while creates (which take tens of seconds) are still in flight.
 */
export const SPAWN_MAX_IN_FLIGHT_PER_SESSION = 8

/** callerSessionId → number of spawn-initiated creates still provisioning. */
const inFlightByCaller = new Map<string, number>()

export interface SpawnReconcileDeps {
  attachIfRunningFn?: () => Promise<boolean>
  fetchPendingFn?: () => Promise<PendingSpawn[]>
  postResultsFn?: (results: SpawnResultWire[]) => Promise<void>
  listSessionPodsFn?: () => Promise<SessionPod[]>
  getDefaultToolFn?: () => Promise<AgentTool | undefined>
  createSessionFn?: (slug: string, opts: SessionCreateOptions) => Promise<SessionCreateResult>
  mintIdFn?: () => string
}

/**
 * Drain queued spawn requests from the proxy and answer each one.
 * `snapshot` keeps the caller lookup on the pass's shared cluster view.
 */
export async function reconcileSpawnRequests(
  deps: SpawnReconcileDeps = {},
  snapshot?: TickSnapshot,
): Promise<void> {
  try {
    // attachIfRunning, not ensureRunning: this step must never bootstrap the
    // proxy (it deploys lazily on the first session create). No proxy → no
    // sessions → nothing queued.
    if (!(await (deps.attachIfRunningFn ?? (() => proxyClient.attachIfRunning()))())) return
    const pending = await (deps.fetchPendingFn ?? (() => proxyClient.fetchPendingSpawns()))()
    if (pending.length === 0) return
    // One pod listing per drain, shared by every request in the batch — the
    // informer cache when it is healthy, otherwise a single kubectl list. A
    // burst at the proxy's queue cap must not fan out into a fork per request.
    const listPods = deps.listSessionPodsFn
      ?? (snapshot ? () => snapshot.pods() : listSessionPods)
    let pods: Promise<SessionPod[]> | undefined
    const drainDeps: SpawnReconcileDeps = { ...deps, listSessionPodsFn: () => (pods ??= listPods()) }
    const results = await Promise.all(pending.map((req) => handleSpawnRequest(req, drainDeps)))
    await (deps.postResultsFn ?? ((r: SpawnResultWire[]) => proxyClient.postSpawnResults(r)))(results)
  } catch (err) {
    serverLog(`[spawn] reconcile failed: ${String(err)}`)
  }
}

/**
 * Answer one spawn request: resolve the caller's project/tool from its pod
 * labels, mint the new session id, detach the create, and return the result
 * the proxy relays to the waiting pod. Exported for unit tests.
 */
export async function handleSpawnRequest(
  req: PendingSpawn,
  deps: SpawnReconcileDeps = {},
): Promise<SpawnResultWire> {
  const fail = (error: string): SpawnResultWire => ({ requestId: req.requestId, ok: false, error })

  // Re-validate what the proxy already checked — defense in depth.
  if (req.prompt.trim().length === 0) return fail('prompt must not be empty')
  if (req.prompt.length > SPAWN_MAX_PROMPT_CHARS) {
    return fail(`prompt exceeds ${SPAWN_MAX_PROMPT_CHARS} characters`)
  }
  if (req.tool !== undefined && !(AGENT_TOOLS as readonly string[]).includes(req.tool)) {
    return fail(`invalid tool '${req.tool}' (expected one of: ${AGENT_TOOLS.join(', ')})`)
  }
  if (req.model !== undefined && !MODEL_RE.test(req.model)) {
    return fail(`invalid model '${req.model}'`)
  }

  let caller: SessionPod | undefined
  try {
    const pods = await (deps.listSessionPodsFn ?? listSessionPods)()
    caller = pods.find((p) => p.sessionId === req.sessionId)
  } catch (err) {
    return fail(`cannot resolve calling session: ${String(err)}`)
  }
  if (!caller) return fail('calling session not found')

  const inFlight = inFlightByCaller.get(req.sessionId) ?? 0
  if (inFlight >= SPAWN_MAX_IN_FLIGHT_PER_SESSION) {
    return fail(`too many concurrent spawns (max ${SPAWN_MAX_IN_FLIGHT_PER_SESSION} provisioning at once)`)
  }

  // Tool precedence: explicit request > the caller's own tool > the
  // configured default > claude.
  const callerTool = (AGENT_TOOLS as readonly string[]).includes(caller.tool)
    ? caller.tool as AgentTool
    : undefined
  const tool = (req.tool as AgentTool | undefined)
    ?? callerTool
    ?? (await (deps.getDefaultToolFn ?? getDefaultTool)())
    ?? 'claude'

  const newSessionId = (deps.mintIdFn ?? (() => crypto.randomUUID()))()
  const projectSlug = caller.projectSlug
  inFlightByCaller.set(req.sessionId, inFlight + 1)
  // Register the sidebar row before detaching, then run the create under the
  // same row lifecycle as a user-initiated create — the spawned session shows
  // provisioning progress in the webapp and a failed spawn leaves a failed
  // row (dismissable) instead of vanishing silently.
  registerProvisioning({ sessionId: newSessionId, projectSlug, tool, kind: 'create' })
  // Detached: the caller gets the minted id immediately; a failed create
  // is a lost fire, logged here.
  void runProvisioned(newSessionId, (onProgress) =>
    (deps.createSessionFn ?? createSession)(projectSlug, {
      tool,
      initialPrompt: req.prompt,
      sessionId: newSessionId,
      model: req.model,
      onProgress,
    })).then(
    () => serverLog(`[spawn] ${req.sessionId.slice(0, 8)}... spawned session ${newSessionId.slice(0, 8)}... in ${projectSlug}`),
    (err: unknown) => serverLog(`[spawn] session create for ${req.sessionId.slice(0, 8)}... failed: ${String(err)}`),
  ).finally(() => {
    const n = (inFlightByCaller.get(req.sessionId) ?? 1) - 1
    if (n <= 0) inFlightByCaller.delete(req.sessionId)
    else inFlightByCaller.set(req.sessionId, n)
  })

  return { requestId: req.requestId, ok: true, sessionId: newSessionId }
}
