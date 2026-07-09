import { DaemonError } from '@/daemon/errors'
import { stripAnsi } from '@/shared/ansi'
import type { AgentTool } from '@/shared/types'

/**
 * Shared core of the daemon's polled CLI sessions — the web-driven tool
 * sign-in (tool-login.ts) and CLI install (tool-install.ts) flows. Both run
 * a vendor CLI in a subprocess the webapp starts and then polls: one live
 * session per tool, killed after 15 minutes unfinished, and kept pollable
 * for a linger window after finishing so polling sees the terminal state.
 * The two managers layer their specifics (claude's credential poller and
 * scratch config dirs, the post-install resolve check) on top.
 */

/** How long a flow may sit unfinished before it is killed. */
const TIMEOUT_MS = 15 * 60 * 1000
/** How long a finished session stays pollable before it is dropped. */
const LINGER_MS = 5 * 60 * 1000

/** The wire-view fields every polled CLI session carries (the common shape
 *  of `ToolLoginView` and `ToolInstallView`). */
export interface CliSessionView {
  id: string
  tool: AgentTool
  status: 'running' | 'success' | 'error'
  output?: string
  error?: string
}

export interface CliSession<V extends CliSessionView = CliSessionView> {
  view: V
  /** Accumulated ANSI-stripped output, presented via `presentableOutput`. */
  buf: string
  proc: { kill: () => void } | null
  timer: ReturnType<typeof setTimeout>
  /** Optional recurring watcher (claude's credential poll); cleared
   *  whenever the session stops. */
  poller: ReturnType<typeof setInterval> | null
}

/** Last few non-empty output lines — the error message when a CLI fails. */
export function outputTail(text: string, lines = 4): string {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-lines).join(' | ')
}

/**
 * claude's stdin prompt. The webapp renders its own paste-code box right
 * below the output, so the CLI's echoed prompt is dropped as a duplicate;
 * anything Ink appends after it (e.g. "Login successful.") survives alone.
 */
const PASTE_PROMPT_RE = /^\s*Paste code here if prompted >?\s*/

/**
 * The CLI output as shown to the user: spinner-frame lines (Ink redraws leave
 * one glyph per frame), consecutive duplicate lines, and claude's paste-code
 * prompt dropped, then capped to the last `maxChars`. The webapp renders this
 * so the user can follow the printed sign-in URL when the daemon couldn't
 * open a browser.
 */
export function presentableOutput(buf: string, maxChars = 4000): string {
  const lines: string[] = []
  for (const raw of buf.split('\n')) {
    let line = raw.trimEnd()
    if (PASTE_PROMPT_RE.test(line)) {
      line = line.replace(PASTE_PROMPT_RE, '')
      if (line === '') continue
    }
    const t = line.trim()
    if (t.length === 1 && !/[0-9A-Za-z]/.test(t)) continue // spinner frame
    if (t === '' && lines[lines.length - 1]?.trim() === '') continue
    if (t !== '' && t === lines[lines.length - 1]?.trim()) continue // Ink re-render
    lines.push(line)
  }
  return lines.join('\n').trim().slice(-maxChars)
}

export interface CliSessionRegistry<S extends CliSession<CliSessionView>> {
  /** The still-running session for a tool, if any (one live per tool). */
  liveForTool(tool: AgentTool): S | undefined
  /** Track a new session with the kill timer armed; the caller attaches
   *  its process afterwards. */
  create(view: S['view'], timeoutError: string, extra: Omit<S, keyof CliSession>): S
  /** The session for an id, or throw NOT_FOUND. */
  getById(id: string): S
  /** Poll a session's state, output included. Throws NOT_FOUND. */
  getView(id: string): S['view']
  /** Append raw CLI output (ANSI-stripped) to the session's buffer. */
  ingest(s: S, raw: string): void
  /** Kill the process, flip the view to its terminal status, and re-arm the
   *  timer to drop the session after the linger window. */
  finish(s: S, status: 'success' | 'error', error?: string): void
  /** Kill a flow and forget it. Unknown ids are a no-op (already gone). */
  cancel(id: string): void
  /** Drop every session (test isolation). */
  clearAllForTests(): void
}

export function createCliSessionRegistry<S extends CliSession<CliSessionView>>(opts: {
  /** NOT_FOUND wording: `No ${noun} "${id}".` */
  noun: string
  /** Extra teardown when a session finishes or is cancelled (scratch config
   *  homes); not run by clearAllForTests, whose dirs the test harness owns. */
  onRelease?: (s: S) => void
}): CliSessionRegistry<S> {
  const sessions = new Map<string, S>()

  function liveForTool(tool: AgentTool): S | undefined {
    for (const s of sessions.values()) {
      if (s.view.tool === tool && s.proc) return s
    }
    return undefined
  }

  function create(view: S['view'], timeoutError: string, extra: Omit<S, keyof CliSession>): S {
    // The timer closes over `s`, so it is armed right after construction;
    // the cast bridges base + extra back to the caller's session type.
    const s = { view, buf: '', proc: null, poller: null, ...extra } as unknown as S
    s.timer = setTimeout(() => { finish(s, 'error', timeoutError) }, TIMEOUT_MS)
    s.timer.unref?.()
    sessions.set(view.id, s)
    return s
  }

  function getById(id: string): S {
    const s = sessions.get(id)
    if (!s) throw new DaemonError('NOT_FOUND', `No ${opts.noun} "${id}".`)
    return s
  }

  function getView(id: string): S['view'] {
    const s = getById(id)
    return { ...s.view, output: presentableOutput(s.buf) }
  }

  function ingest(s: S, raw: string): void {
    s.buf += stripAnsi(raw)
  }

  function finish(s: S, status: 'success' | 'error', error?: string): void {
    s.proc?.kill()
    s.proc = null
    if (s.poller) clearInterval(s.poller)
    s.poller = null
    s.view.status = status
    s.view.error = error
    clearTimeout(s.timer)
    s.timer = setTimeout(() => { sessions.delete(s.view.id) }, LINGER_MS)
    s.timer.unref?.()
    opts.onRelease?.(s)
  }

  function cancel(id: string): void {
    const s = sessions.get(id)
    if (!s) return
    clearTimeout(s.timer)
    if (s.poller) clearInterval(s.poller)
    s.proc?.kill()
    s.proc = null
    sessions.delete(id)
    opts.onRelease?.(s)
  }

  function clearAllForTests(): void {
    for (const s of sessions.values()) {
      clearTimeout(s.timer)
      if (s.poller) clearInterval(s.poller)
      s.proc?.kill()
    }
    sessions.clear()
  }

  return { liveForTool, create, getById, getView, ingest, finish, cancel, clearAllForTests }
}
