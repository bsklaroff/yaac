import { randomBytes } from 'node:crypto'
import { dialPtyStream, sessionExec } from '#platform/k8s/stream-relay'
import { sessionIdFromJobName } from '#platform/k8s/pods'
import { CONTAINER_TMUX_SOCK } from '@yaac/shared/paths'

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/**
 * What a terminal attaches to inside the container:
 *  - 'agent'          — the `yaac` tmux session's agent window (the CLI).
 *  - 'window:@<id>'   — any other window of the `yaac` session (an
 *    initCommands dev server, a scratch shell, …), viewed through a
 *    per-client grouped session so the active window of other viewers
 *    (and the CLI) is never touched.
 *  - 'native'         — the CLI's full-fidelity attach: a per-client
 *    grouped session with the tmux chrome intact (status bar, prefix
 *    keys, `C-b d` detaches), replacing the old client-side
 *    `kubectl exec … tmux attach-session -t yaac`. Grouped rather than a
 *    raw attach so each client keeps its own size/current-window and
 *    `destroy-unattached` cleans up on disconnect.
 *  - 'shell'          — a raw `zsh` exec with no tmux at all (the CLI's
 *    `session shell`): exiting the shell ends the connection.
 */
export type PtyTarget = string

const WINDOW_ID = /^@[0-9]{1,6}$/

/** Coerce a client-supplied target (e.g. a WS query param) to a PtyTarget.
 *  Anything unrecognized falls back to the agent. */
export function parsePtyTarget(raw: unknown): PtyTarget {
  if (typeof raw !== 'string') return 'agent'
  if (raw === 'agent' || raw === 'native' || raw === 'shell') return raw
  if (raw.startsWith('window:') && WINDOW_ID.test(raw.slice('window:'.length))) return raw
  return 'agent'
}

/** Name for a per-client tmux view session. Host-generated (rather than the
 *  container's $$) so the server can address the session later — the detach
 *  on socket close is an explicit `kill-session -t <view>`. */
export function newViewName(): string {
  return `view-${randomBytes(4).toString('hex')}`
}

/**
 * In-pod argv for attaching a tab's PTY, spawned under a real PTY by the
 * pod's streamd (a relay `pty` stream) — the same transport the CLI's
 * `session attach` uses via the server's /pty/attach WebSocket.
 *
 * Every target attaches through a per-client grouped *view* session pinned
 * to a single window, so a webapp tab and a tmux window are the same thing:
 *  - `destroy-unattached on` — the throwaway view session dies on detach
 *    (the windows belong to the group and live on);
 *  - `status off` — no tmux status bar; the webapp tab strip is the only
 *    window list (the CLI's direct `attach-session -t yaac` keeps it);
 *  - `prefix None` — no tmux key bindings; tabs switch via webapp shortcuts
 *    and C-b passes through to the agent. Mouse mode still works (mouse
 *    bindings live in the root key table, which the prefix doesn't gate).
 *
 * The view session is created *detached* — sized to the client, `status off`
 * already applied — and only then attached. `destroy-unattached` is set only
 * after the attach so nothing can reap the view in the created-but-not-yet-
 * attached gap.
 *
 * WINDOW SIZING — a fresh session used to start "scrolled down a little with
 * the right-hand columns cut off". The windows are shared across every grouped
 * view, so under tmux's default (`window-size latest`) each window follows
 * whichever *client viewing it* was most recently active — and there are often
 * several at different sizes: a tiled sibling, a fresh attach briefly
 * overlapping the one it replaces, or a laptop-sleep / network blip that
 * strands a ghost client ("attached", but its kubectl exec died) at a stale
 * size. Any of them can win, leaving the visible pane a few rows/cols off.
 * The fix pins each webapp view's window to THIS client, immune to the others:
 * `set-option -t <view> window-size manual` takes the view out of the
 * negotiation, and `resize-window` sizes it to the client's grid — a
 * per-view-manual window holds its size even while a `latest` ghost of another
 * size views it. bridge()'s resizeWindow hook keeps it in step as the pane
 * resizes later. Manual is set PER VIEW (after create), never globally:
 * container tmux (3.4) segfaults if `new-session` runs while global
 * `window-size` is `manual`, so the group option must stay `latest`.
 * The native (CLI) attach keeps default `latest` sizing (its status bar and
 * live window-switching want the standard behaviour).
 */
export function attachArgs(
  target: PtyTarget,
  viewName: string,
  size: { cols?: number; rows?: number } = {},
): string[] {
  const tmux = `tmux -S ${CONTAINER_TMUX_SOCK}`
  const cols = size.cols ?? DEFAULT_COLS
  const rows = size.rows ?? DEFAULT_ROWS
  // The has-session guard is load-bearing: `new-session -t yaac` against a
  // pod where session-create hasn't yet built the `yaac` session doesn't
  // fail — tmux silently mints a NEW group named `yaac` whose one window is
  // a bare shell, and every later view resolves `-t yaac` to that stale
  // group instead of the real session's windows, permanently. Failing here
  // instead lets the client's reconnect loop retry until setup finishes.
  const create = `${tmux} has-session -t =yaac 2>/dev/null`
    + ` && ${tmux} new-session -d -t yaac -s ${viewName} -x ${cols} -y ${rows}`

  // Native (CLI) attach: keep the tmux chrome — status bar, prefix keys,
  // `C-b d` — and the group's own current window. Only destroy-unattached
  // distinguishes it from a plain `attach-session -t yaac`.
  if (target === 'native') {
    return [
      'sh', '-c',
      create
      + ` && exec ${tmux} attach-session -t ${viewName}`
      + ' \\; set-option destroy-unattached on',
    ]
  }

  // Agent = the yaac session's lowest-index window (`^`): the agent window is
  // created first, and other windows only ever append after it. Same
  // convention as the terminals enumeration.
  const window = target.startsWith('window:')
    ? target.slice('window:'.length)
    : `${viewName}:^`
  // select-window runs inside the attached client's sequence (like the old
  // shape) so a bare window id resolves within the view session, not the
  // group's original. `window-size manual` on the view + `resize-window` pins
  // the shared window to this client's grid (see the sizing note above); both
  // must target this view specifically — global manual segfaults tmux 3.4.
  return [
    'sh', '-c',
    create
    + ` \\; set-option -t ${viewName} status off`
    + ` \\; set-option -t ${viewName} prefix None`
    + ` \\; set-option -t ${viewName} window-size manual`
    + ` && exec ${tmux} attach-session -t ${viewName}`
    + ` \\; select-window -t '${window}'`
    + ` \\; resize-window -t ${viewName} -x ${cols} -y ${rows}`
    + ' \\; set-option destroy-unattached on',
  ]
}

/** The tmux command to resize a webapp view's window to a client grid. The
 *  view is `window-size manual` (see attachArgs), so this is what tracks live
 *  browser-pane resizes — the client SIGWINCH alone no longer moves it. */
export function resizeWindowCmd(viewName: string, cols: number, rows: number): string {
  return `tmux -S ${CONTAINER_TMUX_SOCK} resize-window -t ${viewName} -x ${cols} -y ${rows}`
}

export interface WindowResizer {
  /** Record a new client size. Fires immediately when idle; while an exec is
   *  in flight only the newest size is kept, fired on completion. Property
   *  (not method) form so a detached `resizer.resize` reference is safe to
   *  hand to bridge(). */
  resize: (cols: number, rows: number) => void
  /** Drop any queued resize (connection closing). */
  dispose: () => void
}

/**
 * A "resize the view's tmux window to the client size" driver for bridge()'s
 * resizeWindow hook. Execs are serialized: fire immediately when idle; while
 * one is in flight remember only the newest size and fire it on completion.
 * A lone resize gets no added latency, a burst (a divider drag emits one
 * frame per column step) coalesces to at most one queued follow-up, and the
 * last size always wins — the property a debounce can't give, since two
 * concurrent execs can land out of order and pin the window at a stale size.
 * `exec` is injected so the logic is unit-testable without kubectl; it must
 * never reject (the caller swallows exec failures).
 */
export function makeWindowResizer(
  viewName: string,
  exec: (cmd: string) => Promise<unknown>,
): WindowResizer {
  let inFlight = false
  let pending: { cols: number; rows: number } | null = null
  const pump = (): void => {
    if (inFlight || !pending) return
    const p = pending
    pending = null
    inFlight = true
    const done = (): void => {
      inFlight = false
      pump()
    }
    exec(resizeWindowCmd(viewName, p.cols, p.rows)).then(done, done)
  }
  return {
    resize(cols, rows): void {
      pending = { cols, rows }
      pump()
    },
    dispose(): void {
      pending = null
    },
  }
}

/** Command listing every tmux session name in the pod, one per line. */
export function listSessionsCmd(): string {
  return `tmux -S ${CONTAINER_TMUX_SOCK} list-sessions -F '#{session_name}'`
}

/** Ghost views among `names`: view sessions no live connection owns. The
 *  name-shape check keeps arbitrary session names (yaac, user-created) out
 *  of the kill list even if they happen to start with "view-". */
export function ghostViews(names: string[], live: ReadonlySet<string>): string[] {
  return names.filter((n) => /^view-[0-9a-f]{8}$/.test(n) && !live.has(n))
}

/** One tmux invocation killing all the given view sessions; the command
 *  sequence keeps going past a view that already died on its own. */
export function killViewsCmd(views: string[]): string {
  return `tmux -S ${CONTAINER_TMUX_SOCK} ${views.map((v) => `kill-session -t ${v}`).join(' \\; ')}`
}

/**
 * Reap ghost view sessions in a session pod. A view is per-connection and
 * dies with it (kill-session on socket close, destroy-unattached as the
 * backstop) — but an ungraceful end (server restart or crash, kubectl killed
 * mid-attach, a laptop sleep dropping the exec stream) strands the in-pod
 * tmux client, which pins its view session "attached" forever; pods have
 * been seen carrying dozens. Windows are pinned per view now, so ghosts no
 * longer skew sizing — they're a slow leak of pod memory and tmux state,
 * swept here on every fresh attach. `live` is read after the listing
 * returns, so views attached mid-sweep are never treated as ghosts.
 */
export async function sweepGhostViews(
  jobName: string,
  live: ReadonlySet<string>,
  exec: (jobName: string, cmd: string) => Promise<{ stdout: string }>,
): Promise<void> {
  let listed: { stdout: string }
  try {
    listed = await exec(jobName, listSessionsCmd())
  } catch {
    return // pod gone or tmux not up yet — nothing to sweep
  }
  const names = listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  const ghosts = ghostViews(names, live)
  if (ghosts.length === 0) return
  try {
    await exec(jobName, killViewsCmd(ghosts))
  } catch {
    // raced away (view self-destroyed, pod terminating) — fine
  }
}

/**
 * Detach a webapp client by destroying its per-client view session. With
 * `prefix None` on view sessions there is no detach keystroke to write, and
 * dropping the PTY stream does not always beat the in-pod tmux client to
 * the punch — kill-session works from outside the client and
 * `destroy-unattached` can't save a session that no longer exists.
 * Best-effort: "no such session" (closed before the attach landed, or
 * already reaped) and a gone pod are both fine.
 */
export async function killViewSession(jobName: string, viewName: string): Promise<void> {
  try {
    await sessionExec(
      jobName,
      `tmux -S ${CONTAINER_TMUX_SOCK} kill-session -t ${viewName}`,
      { maxAttempts: 1 },
    )
  } catch {
    // nothing to clean up
  }
}

export interface ControlMessage {
  type: 'resize' | 'signal' | 'ping'
  cols?: number
  rows?: number
  name?: string
}

/** Parse a text control frame. Returns null for anything unrecognized. */
export function parseControl(text: string): ControlMessage | null {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const t = (obj as { type?: unknown }).type
  if (t !== 'resize' && t !== 'signal' && t !== 'ping') return null
  return obj as ControlMessage
}

/** Minimal PTY surface the bridge needs (real impl: node-pty's IPty). */
export interface PtyLike {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

/** Minimal socket surface (real impl: the `ws` WebSocket via WSContext.raw). */
export interface SocketLike {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  onMessage(cb: (data: string | Buffer | ArrayBuffer, isBinary: boolean) => void): void
  onClose(cb: () => void): void
}

function toText(data: string | Buffer | ArrayBuffer): string {
  if (typeof data === 'string') return data
  return Buffer.from(data as ArrayBuffer).toString('utf8')
}

/** How long after the graceful tmux detach to force-kill the PTY. */
const DETACH_GRACE_MS = 400

/**
 * Wire a PTY to a socket per the wire protocol:
 *   - PTY output  → binary frames to the client
 *   - binary in   → PTY stdin (keystrokes)
 *   - text in     → control: {resize}/{signal}/{ping}
 *   - PTY exit    → close the socket
 *   - socket close→ detach tmux gracefully, then kill the PTY
 *
 * The detach-first matters: killing the host-side exec process does not
 * reliably terminate the exec'd tmux client inside the container, so a
 * plain kill can leak a zombie attached client — which, for a view session,
 * also pins the session alive forever (destroy-unattached never fires).
 * `detach` runs the container-side kill-session; it runs again at the grace
 * deadline to catch the attach race (socket closed while kubectl was still
 * connecting, so the first kill found no session to kill), right before the
 * host-side PTY is force-killed as the final fallback.
 */
export function bridge(
  ptyProc: PtyLike,
  sock: SocketLike,
  opts: {
    detach?: () => void
    detachGraceMs?: number
    /** Called on every resize control frame (in addition to resizing the PTY's
     *  own tty) so the caller can resize the tmux window to match — the webapp
     *  view is `window-size manual`, where the tty SIGWINCH alone no longer
     *  moves the window. */
    resizeWindow?: (cols: number, rows: number) => void
  } = {},
): void {
  const detachGraceMs = opts.detachGraceMs ?? DETACH_GRACE_MS
  ptyProc.onData((d) => {
    try {
      sock.send(Buffer.from(d, 'utf8'))
    } catch {
      // socket gone; the close handler will kill the pty
    }
  })

  ptyProc.onExit(({ exitCode }) => {
    try {
      sock.close(1000, `pty exited (${exitCode})`)
    } catch {
      // already closed
    }
  })

  sock.onMessage((data, isBinary) => {
    if (isBinary) {
      ptyProc.write(toText(data))
      return
    }
    const ctrl = parseControl(toText(data))
    if (!ctrl) return
    if (ctrl.type === 'resize' && ctrl.cols && ctrl.rows) {
      ptyProc.resize(ctrl.cols, ctrl.rows)
      opts.resizeWindow?.(ctrl.cols, ctrl.rows)
    } else if (ctrl.type === 'signal' && ctrl.name) {
      ptyProc.kill(ctrl.name)
    } else if (ctrl.type === 'ping') {
      sock.send('{"type":"pong"}')
    }
  })

  sock.onClose(() => {
    opts.detach?.()
    setTimeout(() => {
      opts.detach?.()
      try {
        ptyProc.kill()
      } catch {
        // already gone
      }
    }, detachGraceMs)
  })
}

/**
 * Coerce client-supplied terminal dimensions (e.g. WS query params) into a
 * size object for `spawnAttachPty`. Non-numeric, non-positive, or absurd
 * values become `undefined` so the caller falls back to the 80x24 default.
 * Spawning the attach PTY at the browser's real size — rather than the
 * default and resizing after — avoids the cold-start reflow that garbles
 * full-screen TUIs (the client grid and tmux window agree from frame one).
 */
export function parsePtySize(
  colsRaw: unknown,
  rowsRaw: unknown,
): { cols?: number; rows?: number } {
  const clamp = (v: unknown): number | undefined => {
    const n = Math.trunc(Number(v))
    return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : undefined
  }
  return { cols: clamp(colsRaw), rows: clamp(rowsRaw) }
}

/** Open the attach PTY for a resolved session Job — a relay `pty` stream
 *  whose in-pod side spawns the argv under a real PTY. The 'shell' target
 *  is a raw zsh (no tmux, no view session to clean up); everything else
 *  attaches through a per-client grouped tmux session. */
export function spawnAttachPty(
  jobName: string,
  size: { cols?: number; rows?: number },
  target: PtyTarget,
  viewName: string,
): PtyLike {
  const argv = target === 'shell' ? ['zsh'] : attachArgs(target, viewName, size)
  return dialPtyStream(sessionIdFromJobName(jobName), argv, size)
}
