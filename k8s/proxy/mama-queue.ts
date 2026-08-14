/**
 * In-memory queue bridging in-worktree `yaac-mama` commands to the host
 * server. A worktree pod POSTs to the magic host (`http://yaac.internal/cmd`)
 * on its transparent HTTP egress path; the proxy holds that request open here
 * while the server drains the queue over the control API (`GET /cmd/pending`,
 * claim-on-drain) and posts back `POST /cmd/results`, which completes the
 * held responses. Nothing is persisted: a command is ephemeral, and replaying
 * stale ones after a proxy restart would be worse than dropping them (the
 * in-worktree curl fails loudly and the agent can retry).
 *
 * The queue does not know what any command MEANS. It carries an opaque
 * envelope — a command name, an option map and one free-text body — and the
 * server decides what may run (`runMamaCommand`, which holds the allowlist).
 * That is what keeps this a queue rather than a second implementation of the
 * yaac CLI: adding a command touches the server and the shell script, never
 * this file.
 *
 * Wire shapes are mirrored in packages/server/src/drivers/k8s/egress/proxy-client.ts
 * (PendingMamaRequest / MamaResultWire) — the proxy bundles independently and
 * cannot import server code; keep them in sync.
 */

import crypto from 'node:crypto'

/**
 * Magic hostname the in-worktree `yaac-mama` script POSTs to. Every external
 * name already resolves to the DNS sinkhole and rides the transparent HTTP
 * listener, so this needs no DNS or redirect change — the proxy routes on the
 * Host header alone. Keep in sync with worktree-bin/yaac-mama.
 */
export const MAMA_MAGIC_HOST = 'yaac.internal'
export const MAMA_PATH = '/cmd'
/**
 * The path `yaac-spawn` posted to before commands had names. Still served,
 * mapped to `command=create`, because a worktree created by an older yaac has
 * that script mounted read-only for its whole life
 * (docs/legacy-compat-shims.md).
 */
export const LEGACY_SPAWN_PATH = '/spawn'
/**
 * How long a held request waits for the server before failing with a 504.
 *
 * Sized against the server's worst case for noticing it should drain, which
 * is a silently dead event stream: its read-idle deadline (45s) plus a
 * reconnect backoff (up to 5s) before the reattach re-fires the drain. The
 * normal path is a `mama` event, i.e. immediate, so this budget is only
 * ever spent in that degraded lane — and at 60s it left almost none.
 *
 * `worktree-bin/yaac-mama`'s `--max-time` must stay ABOVE this, so the
 * caller sees this self-describing 504 rather than an opaque curl timeout.
 */
export const MAMA_TTL_MS = 120_000
/** Cap on the buffered request body (a prompt, or a group name). */
export const MAMA_MAX_BODY_BYTES = 64 * 1024
/** Body character limit — mirrors the server's own check. */
export const MAMA_MAX_BODY_CHARS = 10_000
export const MAMA_MAX_PENDING_PER_SESSION = 8
export const MAMA_MAX_PENDING_TOTAL = 32

/**
 * Option names a request may carry, and the shape each value must have.
 *
 * A shape check, NOT an allowlist of what the command may do — the server
 * re-validates every one of these against what the command actually accepts.
 * It exists so the proxy can refuse obvious junk without holding a request
 * open for it, and so no unbounded caller-controlled string reaches the
 * server's own parsing.
 */
const ARG_SHAPES: Record<string, RegExp> = {
  tool: /^[a-z0-9-]{1,32}$/,
  // Mirrors the server's MODEL_RE.
  model: /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/,
  // A group NAME, which is free-form user text (and may be `--`, meaning no
  // group). Bounded, and newline-free so it cannot smuggle a second line
  // into anything that renders it.
  group: /^[^\n\r]{1,200}$/,
  // A worktree id or its short prefix.
  session: /^[A-Za-z0-9-]{1,64}$/,
}

/** Command names the proxy will queue. Deliberately a SHAPE, not a list: the
 *  server holds the real allowlist, and a proxy that had to be upgraded to
 *  carry a new command would make every command change a two-part rollout. */
const COMMAND_RE = /^[a-z][a-z-]{0,31}$/

export interface MamaRequest {
  requestId: string
  /** Calling worktree, attributed from the source pod IP. */
  worktreeId: string
  command: string
  args: Record<string, string>
  body: string
  enqueuedAtMs: number
}

/**
 * How a completed request is written back to the waiting worktree.
 *
 * `json` is what `yaac-mama` speaks, and it is the same shape the
 * containerless route answers with, so one parser in the script serves both
 * substrates. `text` is the pre-envelope `/spawn` reply — a bare worktree id
 * on success, a bare message on failure — which is all the `yaac-spawn`
 * mounted in an older worktree knows how to read
 * (docs/legacy-compat-shims.md).
 */
export type MamaReplyShape = 'json' | 'text'

export interface MamaResult {
  requestId: string
  ok: boolean
  /** What the caller's stdout gets when ok. */
  output?: string
  error?: string
}

/** Writes the held HTTP response back to the waiting worktree pod. */
export type MamaCompleter = (status: number, body: string) => void

/**
 * Read the `{command, args, body}` envelope off a request body.
 *
 * Structure only — `null` for anything that is not that shape, and the value
 * checks are `validateMamaRequest`'s. Non-string arg values are dropped
 * rather than rejected: they cannot be what any command meant, and the
 * server re-validates whatever survives.
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
  // Null-prototype, because every name in here is caller-chosen: nothing that
  // reads this map should be able to reach an inherited member by asking for
  // an ordinary-looking key.
  const args = Object.create(null) as Record<string, string>
  if (typeof env.args === 'object' && env.args !== null && !Array.isArray(env.args)) {
    for (const [name, value] of Object.entries(env.args as Record<string, unknown>)) {
      if (typeof value === 'string') args[name] = value
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
    // hasOwn, not a truthiness index: the map is a plain object, so a name
    // from its prototype chain ("constructor", "toString", …) indexes to a
    // truthy inherited member, passes the guard, and then throws on `.test`
    // — inside a request handler, in a process with no uncaughtException
    // handler. That is one crafted request from inside any sandbox taking
    // egress down for every worktree on the node.
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
  /** How to write this caller's reply — see `MamaReplyShape`. */
  reply: MamaReplyShape
}

export class MamaQueue {
  /** Enqueued, not yet handed to the server. */
  private pending = new Map<string, HeldRequest>()
  /** Drained by the server, awaiting its result. */
  private claimed = new Map<string, HeldRequest>()

  pendingCountFor(worktreeId: string): number {
    let n = 0
    for (const held of this.pending.values()) {
      if (held.req.worktreeId === worktreeId) n++
    }
    for (const held of this.claimed.values()) {
      if (held.req.worktreeId === worktreeId) n++
    }
    return n
  }

  enqueue(
    req: {
      worktreeId: string
      command: string
      args: Record<string, string>
      body: string
      /** Defaults to the envelope shape; the legacy /spawn path asks for text. */
      reply?: MamaReplyShape
    },
    complete: MamaCompleter,
    now: number = Date.now(),
  ): { ok: true; requestId: string } | { ok: false; status: number; error: string } {
    if (this.pending.size + this.claimed.size >= MAMA_MAX_PENDING_TOTAL) {
      return { ok: false, status: 429, error: 'too many pending yaac-mama requests' }
    }
    if (this.pendingCountFor(req.worktreeId) >= MAMA_MAX_PENDING_PER_SESSION) {
      return {
        ok: false,
        status: 429,
        error: 'too many pending yaac-mama requests from this worktree',
      }
    }
    const requestId = crypto.randomUUID()
    this.pending.set(requestId, {
      req: {
        requestId,
        worktreeId: req.worktreeId,
        command: req.command,
        args: req.args,
        body: req.body,
        enqueuedAtMs: now,
      },
      complete,
      reply: req.reply ?? 'json',
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
    const text = held.reply === 'text'
    if (result.ok) {
      const output = result.output ?? ''
      held.complete(200, text ? output : JSON.stringify({ output }))
    } else {
      const error = result.error ?? 'command failed'
      held.complete(422, text ? error : JSON.stringify({ error }))
    }
    return true
  }

  /**
   * 504 anything (pending or claimed) the server hasn't answered within TTL.
   *
   * The two say different things, and the difference matters to whoever is
   * deciding whether to retry. A PENDING request was never handed over, so
   * nothing ran. A CLAIMED one was — the server took it and then failed to
   * answer (it died, or the result post failed), so the command may well
   * have run. `create` is not idempotent (each mints a fresh id), so
   * retrying that one blindly is how you get a duplicate worktree.
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
          held.complete(504, held.reply === 'text' ? timedOut : JSON.stringify({ error: timedOut }))
        }
      }
    }
  }
}
