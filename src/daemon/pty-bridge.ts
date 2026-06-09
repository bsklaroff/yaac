import * as pty from '@lydell/node-pty'
import type { IPty } from '@lydell/node-pty'
import { CONTAINER_TMUX_SOCK } from '@/shared/paths'

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/**
 * What a terminal tab attaches to inside the container. Each target is its
 * own tmux session on the container's socket, so every attached client has
 * an independent view (no shared-active-window contention) and the shell
 * survives browser reloads like the agent does.
 */
export type PtyTarget = 'agent' | 'shell'

/** Coerce a client-supplied target (e.g. a WS query param) to a PtyTarget. */
export function parsePtyTarget(raw: unknown): PtyTarget {
  return raw === 'shell' ? 'shell' : 'agent'
}

/**
 * Argv for attaching a tab's PTY:
 *  - agent: `tmux attach-session -t yaac` — same invocation as the CLI's
 *    `session attach`.
 *  - shell: ensure the persistent scratch-shell session exists *detached*,
 *    then attach. Deliberately NOT `new-session -A`: two clients attaching
 *    in quick succession (React dev double-mount, fast tab toggles) race the
 *    attached-create and can take the freshly created session down with the
 *    first client. Detached creation + attach is idempotent — the duplicate
 *    create fails harmlessly and both clients attach.
 * Spawned under a PTY on the daemon so podman gets a real tty.
 */
export function attachArgs(containerName: string, target: PtyTarget = 'agent'): string[] {
  if (target === 'shell') {
    const tmux = `tmux -S ${CONTAINER_TMUX_SOCK}`
    return [
      'exec', '-it', containerName,
      'sh', '-c',
      `${tmux} new-session -d -s shell -c /workspace 2>/dev/null; exec ${tmux} attach-session -t shell`,
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

/**
 * Wire a PTY to a socket per the wire protocol:
 *   - PTY output  → binary frames to the client
 *   - binary in   → PTY stdin (keystrokes)
 *   - text in     → control: {resize}/{signal}/{ping}
 *   - PTY exit    → close the socket
 *   - socket close→ kill the PTY (detaches tmux; the session lives on)
 */
export function bridge(ptyProc: PtyLike, sock: SocketLike): void {
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
    try {
      ptyProc.kill()
    } catch {
      // already gone
    }
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
