import { randomBytes } from 'node:crypto'
import { worktreeDriver } from '#drivers/driver'
import { tmuxCmd } from '#runtime/agents'
import { createOutputBatcher } from '@yaac/shared/batcher'
import type { WorkspacePaths } from '#drivers/contract'

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/**
 * What a terminal attaches to inside the container:
 *  - 'agent'          — the `yaac` tmux session's agent window (the CLI).
 *  - 'window:@<id>'   — any other window of the `yaac` tmux session (an
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
 *    `worktree shell`): exiting the shell ends the connection.
 */
type PtyTarget = string

const WINDOW_ID = /^@[0-9]{1,6}$/

/** Coerce a client-supplied target (a WS query param) to a PtyTarget.
 *  Anything unrecognized falls back to the agent. */
function parsePtyTarget(raw: string | undefined): PtyTarget {
  if (raw === undefined) return 'agent'
  if (raw === 'agent' || raw === 'native' || raw === 'shell') return raw
  if (raw.startsWith('window:') && WINDOW_ID.test(raw.slice('window:'.length))) return raw
  return 'agent'
}

/** Name for a per-client tmux view session. Host-generated (rather than the
 *  container's $$) so the server can address the worktree later — the detach
 *  on socket close is an explicit `kill-worktree -t <view>`. */
function newViewName(): string {
  return `view-${randomBytes(4).toString('hex')}`
}

/**
 * In-pod argv for attaching a tab's PTY, spawned under a real PTY by the
 * pod's streamd (a relay `pty` stream) — the same transport the CLI's
 * `worktree attach` uses via the server's /pty/attach WebSocket.
 *
 * Every target attaches through a per-client grouped *view* worktree pinned
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
 * WINDOW SIZING is tmux's own `window-size latest`: a window shared by several
 * views takes the size of the client that most recently attached to it,
 * resized, or typed into it. tmux (3.1+) applies that inside the resize
 * message's own handling, before the redraw, so a pane resize moves the tty
 * and the window together. Anything that resizes the window afterwards, such
 * as a separate `resize-window` exec, lags the grown client, which tmux draws
 * around the old window with overflow dots. The window is selected BEFORE the
 * attach, so the attach itself makes this client the window's latest. A ghost
 * client stranded by a dropped exec never resizes or types, so it regains the
 * window only when the latest client detaches and the ghost is the most
 * recently active viewer left (tmux hands the window to that one), and only
 * until the next live resize or keystroke; the attach-time ghost sweep reaps
 * it.
 * The window's `window-size` is set explicitly rather than inherited, so
 * neither a user's tmux config nor a pin left by an older server can freeze
 * it at another client's size.
 */
function attachArgs(
  target: PtyTarget,
  viewName: string,
  size: { cols?: number; rows?: number },
  paths: WorkspacePaths,
): string[] {
  const tmux = tmuxCmd(paths)
  const cols = size.cols ?? DEFAULT_COLS
  const rows = size.rows ?? DEFAULT_ROWS
  // The has-session guard is load-bearing: `new-session -t yaac` against a
  // pod where worktree-create hasn't yet built the `yaac` tmux session
  // doesn't fail — tmux silently mints a NEW group named `yaac` whose one
  // window is a bare shell, and every later view resolves `-t yaac` to that
  // stale group instead of the real session's windows, permanently. Failing
  // instead lets the client's reconnect loop retry until setup finishes.
  const create = `${tmux} has-session -t =yaac 2>/dev/null`
    + ` && ${tmux} new-session -d -t yaac -s ${viewName} -x ${cols} -y ${rows}`

  // Native (CLI) attach: keep the tmux chrome — status bar, prefix keys,
  // `C-b d` — and the group's own current window. Only destroy-unattached
  // distinguishes it from a plain `attach-session -t yaac`. It switches
  // windows live, so it sets no window's size policy: each has `latest` once
  // a webapp view has attached to it, and tmux's default until then.
  if (target === 'native') {
    return [
      'sh', '-c',
      create
      + ` && exec ${tmux} attach-session -t ${viewName}`
      + ' \\; set-option destroy-unattached on',
    ]
  }

  // Agent = the yaac worktree's lowest-index window (`^`): the agent window is
  // created first, and other windows only ever append after it. Same
  // convention as the terminals enumeration.
  const window = `${viewName}:${target.startsWith('window:') ? target.slice('window:'.length) : '^'}`
  return [
    'sh', '-c',
    create
    + ` \\; set-option -t ${viewName} status off`
    + ` \\; set-option -t ${viewName} prefix None`
    + ` \\; select-window -t '${window}'`
    + ` \\; set-option -w -t '${window}' window-size latest`
    + ` && exec ${tmux} attach-session -t ${viewName}`
    + ' \\; set-option destroy-unattached on',
  ]
}

/** Command listing every tmux session name in the pod, one per line. */
function listTmuxSessionsCmd(paths: WorkspacePaths): string {
  return `${tmuxCmd(paths)} list-sessions -F '#{session_name}'`
}

/** Ghost views among `names`: view sessions no live connection owns. The
 *  name-shape check keeps arbitrary worktree names (yaac, user-created) out
 *  of the kill list even if they happen to start with "view-". */
function ghostViews(names: string[], live: ReadonlySet<string>): string[] {
  return names.filter((n) => /^view-[0-9a-f]{8}$/.test(n) && !live.has(n))
}

/** One tmux invocation killing all the given view sessions; the command
 *  sequence keeps going past a view that already died on its own. */
function killViewsCmd(views: string[], paths: WorkspacePaths): string {
  return `${tmuxCmd(paths)} ${views.map((v) => `kill-session -t ${v}`).join(' \\; ')}`
}

/**
 * Reap ghost view sessions in a worktree pod. A view is per-connection and
 * dies with it (kill-worktree on socket close, destroy-unattached as the
 * backstop) — but an ungraceful end (server restart or crash, kubectl killed
 * mid-attach, a laptop sleep dropping the exec stream) strands the in-pod
 * tmux client, which pins its view session "attached" forever; pods have
 * been seen carrying dozens. Windows are pinned per view now, so ghosts no
 * longer skew sizing — they're a slow leak of pod memory and tmux state,
 * swept here on every fresh attach. `live` is read after the listing
 * returns, so views attached mid-sweep are never treated as ghosts.
 */
async function sweepGhostViews(
  jobName: string,
  live: ReadonlySet<string>,
  paths: WorkspacePaths,
): Promise<void> {
  let listed: { stdout: string }
  try {
    listed = await worktreeDriver().exec(jobName, listTmuxSessionsCmd(paths), { maxAttempts: 1 })
  } catch {
    return // pod gone or tmux not up yet — nothing to sweep
  }
  const names = listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  const ghosts = ghostViews(names, live)
  if (ghosts.length === 0) return
  try {
    await worktreeDriver().exec(jobName, killViewsCmd(ghosts, paths), { maxAttempts: 1 })
  } catch {
    // raced away (view self-destroyed, pod terminating) — fine
  }
}

/**
 * Detach a webapp client by destroying its per-client view session. With
 * `prefix None` on view sessions there is no detach keystroke to write, and
 * dropping the PTY stream does not always beat the in-pod tmux client to
 * the punch — kill-worktree works from outside the client and
 * `destroy-unattached` can't save a worktree that no longer exists.
 * Best-effort: "no such worktree" (closed before the attach landed, or
 * already reaped) and a gone pod are both fine.
 */
async function killViewSession(
  jobName: string,
  viewName: string,
  paths: WorkspacePaths,
): Promise<void> {
  try {
    await worktreeDriver().exec(
      jobName,
      `${tmuxCmd(paths)} kill-session -t ${viewName}`,
      { maxAttempts: 1 },
    )
  } catch {
    // nothing to clean up
  }
}

interface ControlMessage {
  type: 'resize' | 'signal' | 'ping'
  cols?: number
  rows?: number
  name?: string
  /** Ping only: an opaque client stamp the pong echoes back, so the client
   *  can measure the round trip. */
  t?: number
}

/** Parse a text control frame. Returns null for anything unrecognized. */
function parseControl(text: string): ControlMessage | null {
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

/** Minimal PTY surface the bridge needs (real impl: a relay `pty` stream). */
interface PtyLike {
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
export const DETACH_GRACE_MS = 400

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
 * also pins the worktree alive forever (destroy-unattached never fires).
 * `detach` runs the container-side kill-worktree; it runs again at the grace
 * deadline to catch the attach race (socket closed while kubectl was still
 * connecting, so the first kill found no worktree to kill), right before the
 * host-side PTY is force-killed as the final fallback.
 */
function bridge(
  ptyProc: PtyLike,
  sock: SocketLike,
  detach?: () => void,
): void {
  // Output rides a micro-batcher (see @yaac/shared/batcher): one WebSocket
  // message per burst rather than per PTY data event. The pod driver already
  // batches at the source (streamd's own mirror of this batcher), but that
  // one is in the image and so cannot serve the containerless driver, whose
  // host PTY reaches this bridge event by event. Batching here covers both,
  // and costs the pod path nothing: the leading-edge policy flushes a lone
  // write immediately, so keystroke echo pays no added latency.
  const out = createOutputBatcher((chunk) => {
    try {
      sock.send(Buffer.from(chunk, 'utf8'))
    } catch {
      // socket gone; the close handler will kill the pty
    }
  })

  ptyProc.onData((d) => out.push(d))

  ptyProc.onExit(({ exitCode }) => {
    out.flush() // ordering: all output precedes the close
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
    } else if (ctrl.type === 'signal' && ctrl.name) {
      ptyProc.kill(ctrl.name)
    } else if (ctrl.type === 'ping') {
      // Echo the client's stamp so it can time the round trip without
      // keeping its own in-flight table (the browser probes the link this
      // way; see the frontend's link-quality store). A ping without one —
      // the CLI's bare keepalive — still gets the bare pong it expects.
      sock.send(typeof ctrl.t === 'number' && Number.isFinite(ctrl.t)
        ? JSON.stringify({ type: 'pong', t: ctrl.t })
        : '{"type":"pong"}')
    }
  })

  sock.onClose(() => {
    out.dispose()
    detach?.()
    setTimeout(() => {
      detach?.()
      try {
        ptyProc.kill()
      } catch {
        // already gone
      }
    }, DETACH_GRACE_MS)
  })
}

/**
 * Coerce client-supplied terminal dimensions (WS query params) into a size
 * object. Non-numeric, non-positive, or absurd values become `undefined` so
 * the attach falls back to the 80x24 default. Spawning the attach PTY at the
 * browser's real size — rather than the default and resizing after — avoids
 * the cold-start reflow that garbles full-screen TUIs (the client grid and
 * tmux window agree from frame one).
 */
function parsePtySize(
  colsRaw: string | undefined,
  rowsRaw: string | undefined,
): { cols?: number; rows?: number } {
  const clamp = (v: string | undefined): number | undefined => {
    const n = Math.trunc(Number(v))
    return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : undefined
  }
  return { cols: clamp(colsRaw), rows: clamp(rowsRaw) }
}

/**
 * Live tmux view sessions per Job, for the ghost sweep every attach runs:
 * every `view-*` worktree in a pod that isn't in here belongs to a dead
 * connection (crashed server, killed kubectl, sleep-dropped exec) and gets
 * reaped. Server-wide rather than per-connection precisely because a sweep
 * must be able to tell another live tab's view from a corpse.
 */
const liveViews = new Map<string, Set<string>>()

/**
 * Attach one webapp/CLI terminal connection to a worktree pod: open the PTY
 * stream for the requested target and wire it to `socket` for the life of the
 * connection. `query` is the raw /pty/attach query string — the target and
 * the client's grid — validated here rather than by the route.
 *
 * Everything the connection owns in the pod is created and reclaimed here:
 * its per-client tmux view session and the kill-worktree on close.
 */
export function attachPty(
  jobName: string,
  socket: SocketLike,
  query: { target?: string; cols?: string; rows?: string },
): void {
  const target = parsePtyTarget(query.target)
  const size = parsePtySize(query.cols, query.rows)
  const paths = worktreeDriver().workspacePaths(jobName)

  // 'shell' is a raw login-shell exec — no tmux, so there is no view session
  // to register, sweep, resize or kill; exiting the shell ends the
  // connection. `$SHELL` rather than a fixed `zsh`: the workspace's own
  // login shell is the image's business under one driver and the host
  // user's under the other, and only one of those is guaranteed to have zsh.
  if (target === 'shell') {
    bridge(worktreeDriver().dialPty(jobName, ['sh', '-c', 'exec "${SHELL:-sh}" -l'], size), socket)
    return
  }

  const viewName = newViewName()
  // Register this view as live BEFORE the sweep's listing goes out, so a
  // concurrent attach can never reap it (see sweepGhostViews).
  const views = liveViews.get(jobName) ?? new Set<string>()
  views.add(viewName)
  liveViews.set(jobName, views)
  void sweepGhostViews(jobName, views, paths)

  const ptyProc = worktreeDriver()
    .dialPty(jobName, attachArgs(target, viewName, size, paths), size)
  bridge(ptyProc, socket, () => {
    views.delete(viewName)
    // Drop the registry entry only while it is still OURS. `views` is the
    // set captured at attach time, and detach runs twice (again at the
    // grace deadline, see bridge) — long enough for the last connection's
    // close to have emptied the entry, a new connection to have installed
    // a fresh set, and this stale closure to then delete that live set.
    // The orphaned connection is invisible to the next attach's sweep,
    // which reaps its view as a corpse; the client reconnects, wipes the
    // registry the same way on close, and the two attaches proceed to kill
    // each other's views on every retry — a permanent reconnect flicker in
    // every terminal on the worktree.
    if (views.size === 0 && liveViews.get(jobName) === views) liveViews.delete(jobName)
    void killViewSession(jobName, viewName, paths)
  })
}
