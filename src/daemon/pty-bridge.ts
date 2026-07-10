import { randomBytes } from 'node:crypto'
import * as pty from '@lydell/node-pty'
import type { IPty } from '@lydell/node-pty'
import { containerExec, interactiveExecArgs } from '@/lib/k8s/exec'
import { CONTAINER_TMUX_SOCK } from '@/shared/paths'

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
 *  container's $$) so the daemon can address the session later — the detach
 *  on socket close is an explicit `kill-session -t <view>`. */
export function newViewName(): string {
  return `view-${randomBytes(4).toString('hex')}`
}

/**
 * Argv for attaching a tab's PTY: `kubectl exec -it job/<name> -- …`,
 * spawned under a PTY on the daemon so kubectl gets a real tty — the
 * same transport the CLI's `session attach` uses.
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
 * already applied — and only then attached. Creating it attached (the old
 * shape) sized the shared window twice within one command sequence: to
 * `client rows - 1` while the default status bar existed, then back to
 * `client rows` when `status off` landed. tmux's shrink step discards the
 * row *below* the agent's cursor (Claude's bottom hint line) and the grow
 * step restores a history line at the top instead, so the whole screen ends
 * one row lower with the bottom line gone. The agent only heals that if it
 * repaints — and when the two SIGWINCHes coalesce on a same-size reattach it
 * sees no net change and skips, leaving the session "slightly scrolled down"
 * until the first keystroke forces a repaint. Detached create + status off
 * first means attaching is a single resize to the client size (or none at
 * all when the size is unchanged), so the intermediate row-eating size never
 * exists. `destroy-unattached` is set only after the attach so nothing can
 * reap the view in the created-but-not-yet-attached gap.
 */
export function attachArgs(
  jobName: string,
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
    return interactiveExecArgs(jobName, [
      'sh', '-c',
      create
      + ` && exec ${tmux} attach-session -t ${viewName}`
      + ' \\; set-option destroy-unattached on',
    ])
  }

  // Agent = the yaac session's lowest-index window (`^`): the agent window is
  // created first, and other windows only ever append after it. Same
  // convention as the terminals enumeration.
  const window = target.startsWith('window:')
    ? target.slice('window:'.length)
    : `${viewName}:^`
  // select-window runs inside the attached client's sequence (like the old
  // shape) so a bare window id resolves within the view session, not the
  // group's original.
  return interactiveExecArgs(jobName, [
    'sh', '-c',
    create
    + ` \\; set-option -t ${viewName} status off`
    + ` \\; set-option -t ${viewName} prefix None`
    + ` && exec ${tmux} attach-session -t ${viewName}`
    + ` \\; select-window -t '${window}'`
    + ' \\; set-option destroy-unattached on',
  ])
}

/**
 * Detach a webapp client by destroying its per-client view session. With
 * `prefix None` on view sessions there is no detach keystroke to write, and
 * killing the host-side kubectl does not reliably terminate the exec'd tmux
 * client inside the container — kill-session works from outside the client
 * and `destroy-unattached` can't save a session that no longer exists.
 * Best-effort: "no such session" (closed before the attach landed, or
 * already reaped) and a gone pod are both fine.
 */
export async function killViewSession(jobName: string, viewName: string): Promise<void> {
  try {
    await containerExec(
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
  opts: { detach?: () => void; detachGraceMs?: number } = {},
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

/** Spawn the attach PTY for a resolved session Job. The 'shell' target
 *  is a raw zsh exec (no tmux, no view session to clean up); everything
 *  else attaches through a per-client grouped tmux session. */
export function spawnAttachPty(
  jobName: string,
  size: { cols?: number; rows?: number },
  target: PtyTarget,
  viewName: string,
): IPty {
  const args = target === 'shell'
    ? interactiveExecArgs(jobName, ['zsh'])
    : attachArgs(jobName, target, viewName, size)
  return pty.spawn('kubectl', args, {
    name: 'xterm-color',
    cols: size.cols ?? DEFAULT_COLS,
    rows: size.rows ?? DEFAULT_ROWS,
  })
}
