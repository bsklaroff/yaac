import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { ServerError } from '@yaac/shared/errors'
import { serverLog } from '#lib/log'
import type { AgentOp, AgentReport } from '@yaac/shared/auth-agent-protocol'
import type {
  ClaudeOAuthBundle,
  CodexOAuthBundle,
  LoginCallback,
  LoginTool,
  ToolLoginView,
} from '@yaac/shared/types'
import {
  CLAUDE_MANUAL_REDIRECT_URI,
  claudeAuthorizeUrl,
  claudeLoopbackRedirectUri,
  exchangeClaudeCode,
} from './claude-oauth'
import {
  CODEX_LOOPBACK_REDIRECT_URI,
  codexAuthorizeUrl,
  exchangeCodexLoopbackCode,
  pollCodexDeviceCode,
  requestCodexDeviceCode,
} from './codex-oauth'
import { oauthState, pkcePair } from './oauth-pkce'
import { signInTool } from './sign-in'

/**
 * Claude and Codex sign-in, run by the server as an OAuth authorization-code
 * grant with PKCE, so a user can sign in from any client: the webapp on a
 * phone as well as the desktop app or the CLI (docs/tool-sign-in.md). The
 * verifier never leaves the server, and the tokens it trades a code for are
 * stored as the flow's owner's sign-in.
 *
 * How the code gets back depends on where the browser runs:
 *  - loopback: the vendor redirects to a localhost port on the browser's
 *    machine, where the user's desktop auth daemon (told over its socket)
 *    or the CLI that started the flow listens, and hands the code here.
 *  - manual: Claude's authorize page shows a code the user pastes back;
 *    Codex runs its device flow, which this module polls.
 * A loopback flow whose daemon cannot listen, or drops, carries on as a
 * manual one.
 *
 * Each user's daemon socket and flows are their own: a connection replaces
 * only its user's socket, and a flow answers only the user who started it.
 */

const FLOW_TIMEOUT_MS = 15 * 60 * 1000
/** How long a finished flow stays pollable. */
const LINGER_MS = 5 * 60 * 1000
/** How long a start waits for the daemon to say it is listening, so the
 *  page the client opens never redirects to a port nothing holds. */
const LISTEN_WAIT_MS = 3000

/** A pasted or posted code: the authorization code, then optionally the
 *  `#state` Claude's page appends. */
const CODE_INPUT_RE = /^([A-Za-z0-9._~-]{1,1024})(?:#([A-Za-z0-9._~-]{1,256}))?$/

interface AgentSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
}

interface Flow {
  owner: string
  view: ToolLoginView
  verifier: string
  challenge: string
  state: string
  /** The `redirect_uri` the authorize URL names, which the exchange must
   *  repeat. Null in Codex's device flow. */
  redirectUri: string | null
  /** The daemon socket listening for this flow's redirect. */
  daemon: AgentSocketLike | null
  /** Set while a start waits on the daemon: told whether it listens. */
  onListen: ((listening: boolean) => void) | null
  /** A code is being traded; later ones are refused. */
  redeeming: boolean
  ended: boolean
  timer: NodeJS.Timeout
}

const sockets = new Map<string, AgentSocketLike>()
const flows = new Map<string, Flow>()

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function send(sock: AgentSocketLike, op: AgentOp): void {
  try {
    sock.send(JSON.stringify(op))
  } catch { /* socket closing; its disconnect handles the flow */ }
}

function stopListening(flow: Flow): void {
  if (!flow.daemon) return
  send(flow.daemon, { op: 'cancel', id: flow.view.id })
  flow.daemon = null
}

/** End a flow; it stays pollable for LINGER_MS. */
function finish(flow: Flow, status: 'success' | 'error', error?: string): void {
  if (flow.ended) return
  flow.ended = true
  const { id, tool } = flow.view
  flow.view = { id, tool, status, ...(error ? { error } : {}) }
  stopListening(flow)
  clearTimeout(flow.timer)
  flow.timer = setTimeout(() => flows.delete(id), LINGER_MS)
  flow.timer.unref()
}

/** Store the bundle an exchange yields as the owner's sign-in, unless the
 *  flow was cancelled meanwhile. */
async function complete(flow: Flow, exchange: () => Promise<ClaudeOAuthBundle | CodexOAuthBundle>): Promise<void> {
  try {
    const bundle = await exchange()
    if (flow.ended) return
    await signInTool(flow.owner, flow.view.tool, { kind: 'oauth', bundle })
    finish(flow, 'success')
  } catch (err) {
    finish(flow, 'error', message(err))
  }
}

/** Trade the code a redirect carried (caught or pasted). */
function redeem(flow: Flow, code: string): Promise<void> {
  flow.redeeming = true
  flow.view = { ...flow.view, acceptsCode: false }
  stopListening(flow)
  const redirectUri = flow.redirectUri ?? ''
  return complete(flow, () => (flow.view.tool === 'claude'
    ? exchangeClaudeCode({ code, state: flow.state, verifier: flow.verifier, redirectUri })
    : exchangeCodexLoopbackCode(code, flow.verifier)))
}

/** Aim a flow's redirect at a loopback listener: Claude's client takes any
 *  port, so one is picked from the dynamic range; Codex's is fixed. */
function beginLoopback(flow: Flow, acceptsCode: boolean): void {
  const { id, tool } = flow.view
  const { challenge, state } = flow
  flow.redirectUri = tool === 'claude' ? claudeLoopbackRedirectUri(crypto.randomInt(49152, 65536)) : CODEX_LOOPBACK_REDIRECT_URI
  const url = tool === 'claude'
    ? claudeAuthorizeUrl({ challenge, state, redirectUri: flow.redirectUri })
    : codexAuthorizeUrl({ challenge, state })
  flow.view = { id, tool, status: 'running', url, acceptsCode }
}

/** Start the flow that needs no loopback. Throws when Codex refuses a
 *  device code. */
async function beginManual(flow: Flow): Promise<void> {
  const { id, tool } = flow.view
  flow.daemon = null
  if (tool === 'claude') {
    flow.redirectUri = CLAUDE_MANUAL_REDIRECT_URI
    const url = claudeAuthorizeUrl({ challenge: flow.challenge, state: flow.state, redirectUri: flow.redirectUri })
    flow.view = { id, tool, status: 'running', url, acceptsCode: true }
    return
  }
  const device = await requestCodexDeviceCode()
  if (flow.ended) return
  flow.redirectUri = null
  flow.view = { id, tool, status: 'running', url: device.verificationUrl, userCode: device.userCode }
  void (async () => {
    while (!flow.ended) {
      await sleep(device.intervalMs, undefined, { ref: false })
      if (flow.ended) return
      try {
        const bundle = await pollCodexDeviceCode(device)
        if (bundle) {
          await complete(flow, () => Promise.resolve(bundle))
          return
        }
      } catch (err) {
        finish(flow, 'error', message(err))
      }
    }
  })()
}

/** A loopback flow whose listener is gone carries on as a manual one. */
async function fallBack(flow: Flow): Promise<void> {
  try {
    await beginManual(flow)
  } catch (err) {
    finish(flow, 'error', message(err))
  }
}

/** The daemon will not catch this flow's redirect: a start still waiting
 *  on it falls back itself, any other flow falls back here. */
function daemonGone(flow: Flow): void {
  flow.daemon = null
  if (flow.onListen) flow.onListen(false)
  else void fallBack(flow)
}

function dropFlow(flow: Flow): void {
  flow.ended = true
  stopListening(flow)
  clearTimeout(flow.timer)
  flows.delete(flow.view.id)
}

/** The caller's flow; another user's reads as missing. */
function find(owner: string, id: string): Flow | undefined {
  const flow = flows.get(id)
  return flow?.owner === owner ? flow : undefined
}

function get(owner: string, id: string): Flow {
  const flow = find(owner, id)
  if (!flow) throw new ServerError('NOT_FOUND', `No sign-in session "${id}".`)
  return flow
}

/**
 * Start a sign-in, replacing any the owner has running for the tool (whose
 * listener would hold Codex's fixed port). One the daemon catches answers
 * once the daemon holds the port, or as a manual flow if it cannot. A vendor
 * refusing to start one comes back as an error view, as any later failure
 * does.
 */
export async function startToolLogin(owner: string, tool: LoginTool, callback?: LoginCallback): Promise<ToolLoginView> {
  for (const other of flows.values()) {
    if (other.owner === owner && other.view.tool === tool && !other.ended) dropFlow(other)
  }
  const { verifier, challenge } = pkcePair()
  const id = crypto.randomUUID()
  const flow: Flow = {
    owner,
    view: { id, tool, status: 'running' },
    verifier,
    challenge,
    state: oauthState(),
    redirectUri: null,
    daemon: null,
    onListen: null,
    redeeming: false,
    ended: false,
    timer: setTimeout(() => finish(flow, 'error', 'Sign-in timed out after 15 minutes.'), FLOW_TIMEOUT_MS),
  }
  flow.timer.unref()
  flows.set(id, flow)
  const daemon = callback === 'auth-daemon' ? sockets.get(owner) : undefined
  if (daemon) {
    beginLoopback(flow, false)
    flow.daemon = daemon
    const listening = new Promise<boolean>((resolve) => {
      flow.onListen = resolve
      setTimeout(() => resolve(false), LISTEN_WAIT_MS).unref()
    })
    send(daemon, { op: 'listen', id, url: flow.view.url ?? '' })
    const ok = await listening
    flow.onListen = null
    if (!ok && !flow.ended) {
      stopListening(flow)
      await fallBack(flow)
    }
  } else if (callback === 'caller') {
    beginLoopback(flow, true)
  } else {
    await fallBack(flow)
  }
  return flow.view
}

/** Poll a sign-in. */
export function getToolLogin(owner: string, id: string): ToolLoginView {
  return get(owner, id).view
}

/**
 * Finish a sign-in with the code its authorize page produced: pasted from
 * Claude's page, or caught by the CLI's loopback listener. Resolves once the
 * code is traded, with the final view.
 */
export async function submitToolLoginCode(owner: string, id: string, text: string): Promise<ToolLoginView> {
  const flow = get(owner, id)
  if (flow.ended || flow.redeeming || !flow.view.acceptsCode) {
    throw new ServerError('CONFLICT', 'This sign-in is not accepting a code.')
  }
  const match = CODE_INPUT_RE.exec(text.trim())
  if (!match) {
    throw new ServerError('VALIDATION', 'Expected the code from the authorize page (letters, digits, "#", ".", "-", "_", "~" only).')
  }
  if (match[2] !== undefined && match[2] !== flow.state) {
    throw new ServerError('VALIDATION', 'That code is from a different sign-in. Paste the one from the page this sign-in opened.')
  }
  await redeem(flow, match[1])
  return flow.view
}

/** Abandon a sign-in. Unknown ids are a no-op (already gone). */
export function cancelToolLogin(owner: string, id: string): void {
  const flow = find(owner, id)
  if (flow) dropFlow(flow)
}

function parseReport(raw: string): AgentReport | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const r = parsed as Record<string, unknown>
  if (typeof r.id !== 'string') return null
  if (r.op === 'callback' && typeof r.code === 'string' && typeof r.state === 'string') {
    return { op: 'callback', id: r.id, code: r.code, state: r.state }
  }
  if (r.op === 'listening') return { op: 'listening', id: r.id }
  if ((r.op === 'listen-failed' || r.op === 'denied') && typeof r.error === 'string') {
    return { op: r.op, id: r.id, error: r.error }
  }
  return null
}

/** Each user's desktop auth daemon socket, which the WebSocket upgrade
 *  hands over, and what it reports. */
export const authAgentHub = {
  setSocket(owner: string, sock: AgentSocketLike): void {
    const previous = sockets.get(owner)
    if (previous && previous !== sock) {
      try {
        previous.close(1000, 'replaced by a newer auth daemon connection')
      } catch { /* already gone */ }
    }
    sockets.set(owner, sock)
    serverLog(`[server] auth daemon connected for user ${owner}`)
  },

  /** A daemon's listeners die with its socket, so its flows fall back. */
  handleDisconnect(owner: string, sock: AgentSocketLike): void {
    if (sockets.get(owner) === sock) {
      sockets.delete(owner)
      serverLog(`[server] auth daemon disconnected for user ${owner}`)
    }
    for (const flow of flows.values()) {
      if (flow.daemon === sock && !flow.ended && !flow.redeeming) daemonGone(flow)
    }
  },

  /** A report from the owner's daemon, about one of the owner's flows. */
  ingest(owner: string, raw: string): void {
    const report = parseReport(raw)
    const flow = report && find(owner, report.id)
    if (!report || !flow?.daemon || flow.ended || flow.redeeming) return
    if (report.op === 'listening') {
      flow.onListen?.(true)
    } else if (report.op === 'listen-failed') {
      serverLog(`[server] auth daemon could not listen for a ${flow.view.tool} sign-in: ${report.error}`)
      daemonGone(flow)
    } else if (report.op === 'denied') {
      finish(flow, 'error', report.error)
    } else if (report.state === flow.state) {
      void redeem(flow, report.code)
    }
  },

  connected(owner: string): boolean {
    return sockets.has(owner)
  },

  clearForTests(): void {
    for (const flow of flows.values()) {
      flow.ended = true
      clearTimeout(flow.timer)
    }
    flows.clear()
    sockets.clear()
  },
}
