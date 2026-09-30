/**
 * In-memory queue that carries in-workspace `yaac-mama` commands to the yaac
 * server. A workspace pod POSTs to `http://yaac.internal/cmd` over its
 * transparent HTTP egress path, and the proxy holds that request open. The
 * server drains the queue through the control API (`GET /cmd/pending`) and
 * answers with `POST /cmd/results`, which completes the held responses.
 * Nothing is persisted; after a proxy restart the caller's curl fails and
 * the agent can retry.
 *
 * The queue carries an opaque envelope (command name, options, free-text
 * body). The server decides what may run (`runMamaCommand`), so adding a
 * command never touches this file.
 *
 * The wire shapes mirror PendingMamaRequest / MamaResultWire in
 * packages/shared/src/types.ts; the proxy cannot import them, so keep them in
 * sync.
 */

import crypto from 'node:crypto'

/**
 * Hostname the in-workspace `yaac-mama` script POSTs to. It reaches the
 * transparent HTTP listener like any external name, and the proxy routes on
 * the Host header. Keep in sync with workspace-bin/yaac-mama.
 */
export const MAMA_MAGIC_HOST = 'yaac.internal'
export const MAMA_PATH = '/cmd'
/**
 * How long a held request waits for the server before failing with a 504.
 * Normally the server drains at once on a `mama` event; the worst case is a
 * silently dead event stream (45s read-idle deadline plus up to 5s reconnect
 * backoff). `workspace-bin/yaac-mama`'s `--max-time` must stay above this so
 * the caller sees the 504 rather than a curl timeout.
 */
export const MAMA_TTL_MS = 120_000
/** Cap on the buffered request body (a prompt, or a group name). */
export const MAMA_MAX_BODY_BYTES = 64 * 1024
/** Body character limit — mirrors the server's own check. */
export const MAMA_MAX_BODY_CHARS = 10_000
export const MAMA_MAX_PENDING_PER_WORKSPACE = 8
export const MAMA_MAX_PENDING_TOTAL = 32

/**
 * Option names a request may carry, and the shape each value must have. The
 * server re-validates each against what the command accepts; this only
 * rejects junk early and bounds what reaches the server.
 */
const ARG_SHAPES: Record<string, RegExp> = {
  tool: /^[a-z0-9-]{1,32}$/,
  'permission-mode': /^[a-z-]{1,32}$/,
  'ui-mode': /^[a-z-]{1,32}$/,
  // git refuses whitespace in a branch name.
  branch: /^\S{1,255}$/,
  // Mirrors the server's MODEL_RE.
  model: /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/,
  // Free-form text (`--` means no group); single-line so it renders safely.
  group: /^[^\n\r]{1,200}$/,
  title: /^[^\n\r]{1,200}$/,
  // A workspace or queued workspace id, or its short prefix.
  workspace: /^[A-Za-z0-9-]{1,64}$/,
  'parent-workspace': /^[A-Za-z0-9-]{1,64}$/,
  queued: /^[A-Za-z0-9-]{1,64}$/,
}

/** Shape of a command name. The server holds the real allowlist, so a new
 *  command needs no proxy upgrade. */
const COMMAND_RE = /^[a-z][a-z-]{0,31}$/

export interface MamaRequest {
  requestId: string
  /** Calling workspace, attributed from the source pod IP. */
  workspaceId: string
  command: string
  args: Record<string, string>
  body: string
  enqueuedAtMs: number
}

export interface MamaResult {
  requestId: string
  ok: boolean
  /** What the caller's stdout gets when ok. */
  output?: string
  error?: string
}

/** Writes the held HTTP response back to the waiting workspace pod. */
export type MamaCompleter = (status: number, body: string) => void

/**
 * Option names sent by the `yaac-mama` an older install staged in its
 * workspaces, mapped to the current ones (docs/legacy-compat-shims.md).
 */
const LEGACY_ARGS = new Map([['worktree', 'workspace'], ['parent-worktree', 'parent-workspace']])

/**
 * Read the `{command, args, body}` envelope off a request body, or null if it
 * is not that shape. Values are checked by `validateMamaRequest`; non-string
 * arg values are dropped.
 */
export function parseMamaEnvelope(
  raw: string,
): { command: string; args: Record<string, string>; body: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const env = parsed as Record<string, unknown>
  if (typeof env.command !== 'string') return null
  // Null prototype: the keys are caller-chosen.
  const args = Object.create(null) as Record<string, string>
  if (typeof env.args === 'object' && env.args !== null && !Array.isArray(env.args)) {
    for (const [name, value] of Object.entries(env.args as Record<string, unknown>)) {
      if (typeof value === 'string') args[LEGACY_ARGS.get(name) ?? name] = value
    }
  }
  return {
    command: env.command,
    args,
    body: typeof env.body === 'string' ? env.body : '',
  }
}

export function validateMamaRequest(
  command: string,
  args: Record<string, string>,
  body: string,
): { ok: true } | { ok: false; status: number; error: string } {
  if (!COMMAND_RE.test(command)) {
    return { ok: false, status: 400, error: `invalid command '${command}'` }
  }
  if (body.length > MAMA_MAX_BODY_CHARS) {
    return { ok: false, status: 400, error: `argument exceeds ${MAMA_MAX_BODY_CHARS} characters` }
  }
  for (const [name, value] of Object.entries(args)) {
    // hasOwn: a name like "constructor" would otherwise reach an inherited
    // member and throw on `.test`, crashing the proxy for the whole node.
    if (!Object.hasOwn(ARG_SHAPES, name)) {
      return { ok: false, status: 400, error: `unknown option '--${name}'` }
    }
    if (!ARG_SHAPES[name].test(value)) {
      return { ok: false, status: 400, error: `invalid value for --${name}` }
    }
  }
  return { ok: true }
}

interface HeldRequest {
  req: MamaRequest
  complete: MamaCompleter
}

export class MamaQueue {
  /** Enqueued, not yet handed to the server. */
  private pending = new Map<string, HeldRequest>()
  /** Drained by the server, awaiting its result. */
  private claimed = new Map<string, HeldRequest>()

  pendingCountFor(workspaceId: string): number {
    let n = 0
    for (const held of this.pending.values()) {
      if (held.req.workspaceId === workspaceId) n++
    }
    for (const held of this.claimed.values()) {
      if (held.req.workspaceId === workspaceId) n++
    }
    return n
  }

  enqueue(
    req: {
      workspaceId: string
      command: string
      args: Record<string, string>
      body: string
    },
    complete: MamaCompleter,
    now: number = Date.now(),
  ): { ok: true; requestId: string } | { ok: false; status: number; error: string } {
    if (this.pending.size + this.claimed.size >= MAMA_MAX_PENDING_TOTAL) {
      return { ok: false, status: 429, error: 'too many pending yaac-mama requests' }
    }
    if (this.pendingCountFor(req.workspaceId) >= MAMA_MAX_PENDING_PER_WORKSPACE) {
      return {
        ok: false,
        status: 429,
        error: 'too many pending yaac-mama requests from this workspace',
      }
    }
    const requestId = crypto.randomUUID()
    this.pending.set(requestId, {
      req: {
        requestId,
        workspaceId: req.workspaceId,
        command: req.command,
        args: req.args,
        body: req.body,
        enqueuedAtMs: now,
      },
      complete,
    })
    return { ok: true, requestId }
  }

  /** Hand every pending request to the server (claim: a second drain is empty). */
  drain(): MamaRequest[] {
    const out: MamaRequest[] = []
    for (const [id, held] of this.pending) {
      this.claimed.set(id, held)
      out.push(held.req)
    }
    this.pending.clear()
    return out
  }

  /** Resolve a held request with the server's result. False if unknown/expired. */
  complete(result: MamaResult): boolean {
    const held = this.claimed.get(result.requestId) ?? this.pending.get(result.requestId)
    if (!held) return false
    this.claimed.delete(result.requestId)
    this.pending.delete(result.requestId)
    if (result.ok) {
      held.complete(200, JSON.stringify({ output: result.output ?? '' }))
    } else {
      held.complete(422, JSON.stringify({ error: result.error ?? 'command failed' }))
    }
    return true
  }

  /**
   * 504 anything the server hasn't answered within the TTL. The message
   * differs because it guides retries: a pending request never ran, but a
   * claimed one may have, and retrying a non-idempotent `create` would make
   * a duplicate workspace.
   */
  expire(now: number = Date.now()): void {
    for (const [map, timedOut] of [
      [this.pending, 'the yaac server did not pick this up (is it running?) — nothing ran'],
      [this.claimed, 'the yaac server took this request but never answered — it MAY have run;'
        + ' check `yaac-mama list` before retrying'],
    ] as const) {
      for (const [id, held] of map) {
        if (now - held.req.enqueuedAtMs >= MAMA_TTL_MS) {
          map.delete(id)
          held.complete(504, JSON.stringify({ error: timedOut }))
        }
      }
    }
  }
}
