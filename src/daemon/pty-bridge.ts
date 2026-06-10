import * as pty from '@lydell/node-pty'
import type { IPty } from '@lydell/node-pty'
import { CONTAINER_TMUX_SOCK } from '@/shared/paths'

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/**
 * What a terminal tab attaches to inside the container:
 *  - 'agent'          — the primary `yaac` tmux session (the agent CLI).
 *  - 'shell:<name>'   — a scratch-shell tmux session ('shell', 'shell-2', …),
 *    created lazily; persists across reloads. 'shell' is accepted as an
 *    alias for 'shell:shell'.
 *  - 'window:@<id>'   — a specific window of the `yaac` session (e.g. an
 *    initCommands dev server), viewed through a per-client grouped session
 *    so the active window of other viewers (and the CLI) is never touched.
 *  - 'agent-view'     — the agent window through a per-client grouped
 *    session: an independent view that can't move the owner's active
 *    window or fight its size. What shared-session guests get.
 */
export type PtyTarget = string

const SHELL_NAME = /^shell(?:-[0-9]{1,4})?$/
const WINDOW_ID = /^@[0-9]{1,6}$/

/** Coerce a client-supplied target (e.g. a WS query param) to a PtyTarget.
 *  Anything unrecognized falls back to the agent. */
export function parsePtyTarget(raw: unknown): PtyTarget {
  if (typeof raw !== 'string') return 'agent'
  if (raw === 'agent') return 'agent'
  if (raw === 'agent-view') return 'agent-view'
  if (raw === 'shell') return 'shell:shell'
  if (raw.startsWith('shell:') && SHELL_NAME.test(raw.slice('shell:'.length))) return raw
  if (raw.startsWith('window:') && WINDOW_ID.test(raw.slice('window:'.length))) return raw
  return 'agent'
}

/**
 * Argv for attaching a tab's PTY. Spawned under a PTY on the daemon so
 * podman gets a real tty.
 *
 * Shells: ensure the session exists *detached*, then attach. Deliberately
 * NOT `new-session -A`: two clients attaching in quick succession (React
 * dev double-mount, fast tab toggles) race the attached-create and can take
 * the freshly created session down with the first client. Detached creation
 * + attach is idempotent — the duplicate create fails harmlessly.
 *
 * Windows: attach via a per-client grouped session (`new-session -t yaac`)
 * with destroy-unattached on, so each viewer selects the window
 * independently and the throwaway grouped session dies on detach (the
 * windows themselves belong to the group and live on).
 */
export function attachArgs(containerName: string, target: PtyTarget = 'agent'): string[] {
  const tmux = `tmux -S ${CONTAINER_TMUX_SOCK}`
  if (target.startsWith('shell:')) {
    const name = target.slice('shell:'.length)
    return [
      'exec', '-it', containerName,
      'sh', '-c',
      `${tmux} new-session -d -s ${name} -c /workspace 2>/dev/null; exec ${tmux} attach-session -t ${name}`,
    ]
  }
  if (target.startsWith('window:')) {
    const windowId = target.slice('window:'.length)
    return [
      'exec', '-it', containerName,
      'sh', '-c',
      `exec ${tmux} new-session -t yaac -s view-$$ \\; set-option destroy-unattached on \\; select-window -t '${windowId}'`,
    ]
  }
  if (target === 'agent-view') {
    return [
      'exec', '-it', containerName,
      'sh', '-c',
      `exec ${tmux} new-session -t yaac -s view-$$ \\; set-option destroy-unattached on \\; select-window -t yaac:0`,
    ]
  }
  return [
    'exec', '-it', containerName,
    'tmux', '-S', CONTAINER_TMUX_SOCK, 'attach-session', '-t', 'yaac',
  ]
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
 * The detach-first matters: killing the host-side `podman exec` does NOT
 * terminate the exec'd tmux client inside the container (podman orphans
 * exec sessions), so a plain kill leaks a zombie attached client in the
 * container on every disconnect. Writing the detach keystroke (prefix + d;
 * the containers run stock tmux bindings) makes the client exit cleanly on
 * both sides; the delayed kill is the fallback for a wedged client.
 */
export function bridge(
  ptyProc: PtyLike,
  sock: SocketLike,
  opts: { detachGraceMs?: number; readOnly?: boolean } = {},
): void {
  const detachGraceMs = opts.detachGraceMs ?? DETACH_GRACE_MS
  const readOnly = opts.readOnly ?? false
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
      // View-mode guests can look but not type.
      if (!readOnly) ptyProc.write(toText(data))
      return
    }
    const ctrl = parseControl(toText(data))
    if (!ctrl) return
    if (ctrl.type === 'resize' && ctrl.cols && ctrl.rows) {
      ptyProc.resize(ctrl.cols, ctrl.rows)
    } else if (ctrl.type === 'signal' && ctrl.name) {
      if (!readOnly) ptyProc.kill(ctrl.name)
    } else if (ctrl.type === 'ping') {
      sock.send('{"type":"pong"}')
    }
  })

  sock.onClose(() => {
    try {
      ptyProc.write('\x02d') // C-b d: detach the tmux client cleanly
    } catch {
      // pty already gone
    }
    setTimeout(() => {
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

/** Spawn the attach PTY for a resolved container. */
export function spawnAttachPty(
  containerName: string,
  size: { cols?: number; rows?: number } = {},
  target: PtyTarget = 'agent',
): IPty {
  return pty.spawn('podman', attachArgs(containerName, target), {
    name: 'xterm-color',
    cols: size.cols ?? DEFAULT_COLS,
    rows: size.rows ?? DEFAULT_ROWS,
  })
}
