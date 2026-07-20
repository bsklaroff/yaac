/**
 * In-memory queue bridging in-session `yaac-spawn` requests to the host
 * server. A session pod POSTs to the magic host (`http://yaac.internal/spawn`)
 * on its transparent HTTP egress path; the proxy holds that request open here
 * while the server drains the queue over the control API (`GET /spawn/pending`,
 * claim-on-drain) and posts back `POST /spawn/results`, which completes the
 * held responses. Nothing is persisted: a spawn is ephemeral, and replaying
 * stale spawn requests after a proxy restart would be worse than dropping
 * them (the in-session curl fails loudly and the agent can retry).
 *
 * Wire shapes are mirrored in packages/server/src/lib/container/proxy-client.ts
 * (PendingSpawn / SpawnResultWire) — the proxy bundles independently and
 * cannot import server code; keep them in sync.
 */

import crypto from 'node:crypto'

/**
 * Magic hostname the in-session `yaac-spawn` script POSTs to. Every external
 * name already resolves to the DNS sinkhole and rides the transparent HTTP
 * listener, so this needs no DNS or Cilium change — the proxy routes on the
 * Host header alone. Keep in sync with session-bin/yaac-spawn.
 */
export const SPAWN_MAGIC_HOST = 'yaac.internal'
export const SPAWN_PATH = '/spawn'
/** How long a held request waits for the server before failing with a 504. */
export const SPAWN_TTL_MS = 60_000
/** Cap on the buffered request body (the prompt). */
export const SPAWN_MAX_BODY_BYTES = 64 * 1024
/** Prompt character limit — mirrors the schedule route's zod max. */
export const SPAWN_MAX_PROMPT_CHARS = 10_000
export const SPAWN_MAX_PENDING_PER_SESSION = 4
export const SPAWN_MAX_PENDING_TOTAL = 32

export interface SpawnRequest {
  requestId: string
  /** Calling session, attributed from the source pod IP. */
  sessionId: string
  prompt: string
  tool?: string
  /** Claude-only model override for the spawned session's agent. */
  model?: string
  enqueuedAtMs: number
}

export interface SpawnResult {
  requestId: string
  ok: boolean
  /** New session id when ok. */
  sessionId?: string
  error?: string
}

/** Writes the held HTTP response back to the waiting session pod. */
export type SpawnCompleter = (status: number, body: string) => void

export function validateSpawnRequest(
  prompt: string,
  tool: string | undefined,
  model?: string,
): { ok: true } | { ok: false; status: number; error: string } {
  if (prompt.trim().length === 0) {
    return { ok: false, status: 400, error: 'prompt must not be empty' }
  }
  if (prompt.length > SPAWN_MAX_PROMPT_CHARS) {
    return { ok: false, status: 400, error: `prompt exceeds ${SPAWN_MAX_PROMPT_CHARS} characters` }
  }
  // Shape check only — the server validates against its real tool list.
  if (tool !== undefined && !/^[a-z0-9-]{1,32}$/.test(tool)) {
    return { ok: false, status: 400, error: `invalid tool '${tool}'` }
  }
  // Shape check mirroring the server's MODEL_RE (packages/server
  // session-create.ts) — the server re-validates before use.
  if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(model)) {
    return { ok: false, status: 400, error: `invalid model '${model}'` }
  }
  return { ok: true }
}

interface HeldRequest {
  req: SpawnRequest
  complete: SpawnCompleter
}

export class SpawnQueue {
  /** Enqueued, not yet handed to the server. */
  private pending = new Map<string, HeldRequest>()
  /** Drained by the server, awaiting its result. */
  private claimed = new Map<string, HeldRequest>()

  pendingCountFor(sessionId: string): number {
    let n = 0
    for (const held of this.pending.values()) {
      if (held.req.sessionId === sessionId) n++
    }
    for (const held of this.claimed.values()) {
      if (held.req.sessionId === sessionId) n++
    }
    return n
  }

  enqueue(
    req: { sessionId: string; prompt: string; tool?: string; model?: string },
    complete: SpawnCompleter,
    now: number = Date.now(),
  ): { ok: true; requestId: string } | { ok: false; status: number; error: string } {
    if (this.pending.size + this.claimed.size >= SPAWN_MAX_PENDING_TOTAL) {
      return { ok: false, status: 429, error: 'too many pending spawn requests' }
    }
    if (this.pendingCountFor(req.sessionId) >= SPAWN_MAX_PENDING_PER_SESSION) {
      return { ok: false, status: 429, error: 'too many pending spawn requests from this session' }
    }
    const requestId = crypto.randomUUID()
    this.pending.set(requestId, {
      req: { requestId, sessionId: req.sessionId, prompt: req.prompt, tool: req.tool, model: req.model, enqueuedAtMs: now },
      complete,
    })
    return { ok: true, requestId }
  }

  /** Hand every pending request to the server (claim: a second drain is empty). */
  drain(): SpawnRequest[] {
    const out: SpawnRequest[] = []
    for (const [id, held] of this.pending) {
      this.claimed.set(id, held)
      out.push(held.req)
    }
    this.pending.clear()
    return out
  }

  /** Resolve a held request with the server's result. False if unknown/expired. */
  complete(result: SpawnResult): boolean {
    const held = this.claimed.get(result.requestId) ?? this.pending.get(result.requestId)
    if (!held) return false
    this.claimed.delete(result.requestId)
    this.pending.delete(result.requestId)
    if (result.ok && result.sessionId) {
      held.complete(200, result.sessionId)
    } else {
      held.complete(422, result.error ?? 'spawn failed')
    }
    return true
  }

  /** 504 anything (pending or claimed) the server hasn't answered within TTL. */
  expire(now: number = Date.now()): void {
    for (const map of [this.pending, this.claimed]) {
      for (const [id, held] of map) {
        if (now - held.req.enqueuedAtMs >= SPAWN_TTL_MS) {
          map.delete(id)
          held.complete(504, 'yaac server did not pick up the spawn request (is the server running?)')
        }
      }
    }
  }
}
