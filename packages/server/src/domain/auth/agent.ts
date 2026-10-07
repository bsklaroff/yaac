import crypto from 'node:crypto'
import { ServerError } from '@yaac/shared/errors'
import { serverLog } from '#log'
import type { AgentKind, AgentOp, AgentTool2 } from '@yaac/shared/auth-agent-protocol'
import type { ToolInstallView, ToolLoginView } from '@yaac/shared/types'

/**
 * Relay between the sign-in routes and the auth server on a user's machine,
 * where vendor login/install flows run (the browser and vendors' localhost
 * OAuth callbacks are there, not necessarily on the server host). The hub
 * forwards ops over each user's WebSocket and caches the views their auth
 * server pushes back, which the polled routes serve.
 *
 * Every user has their own socket and flows. A connection replaces only its
 * own user's socket, and a flow answers only the user who started it, so no
 * user can take over another's sign-in or receive a code they paste.
 *
 * Protocol, with no request/response correlation:
 *  - down (server → agent):  {op:'start'|'input'|'cancel', id, ...}
 *  - up   (agent → server):  {op:'view', kind, view} on every change
 * Flow ids are minted here so a start can return a 'running' view
 * immediately. Credentials never pass through the hub: on success the auth
 * server PUTs the bundle to /auth/:tool itself, as its user.
 */

interface AgentViewMsg {
  op: 'view'
  kind: AgentKind
  view: ToolLoginView | ToolInstallView
}

/** Parse an upstream agent frame; null for anything unrecognized. */
function parseAgentViewMsg(raw: string): AgentViewMsg | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const m = obj as { op?: unknown; kind?: unknown; view?: unknown }
  if (m.op !== 'view' || (m.kind !== 'login' && m.kind !== 'install')) return null
  const view = m.view as { id?: unknown; status?: unknown } | null
  if (!view || typeof view !== 'object' || typeof view.id !== 'string') return null
  if (view.status !== 'running' && view.status !== 'success' && view.status !== 'error') return null
  return m as AgentViewMsg
}

/** The allowlist the auth server applies before writing to the login PTY,
 *  checked here too so bad input fails fast with a message. */
const LOGIN_INPUT_RE = /^[A-Za-z0-9_#-]{1,512}$/

/** How long a finished flow stays pollable (mirrors the agent's linger). */
const LINGER_MS = 5 * 60 * 1000

interface AgentSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
}

interface FlowEntry {
  /** The user who started it. */
  owner: string
  kind: AgentKind
  view: ToolLoginView | ToolInstallView
  linger: ReturnType<typeof setTimeout> | null
}

const DISCONNECTED_MESSAGE =
  'No auth server is connected — sign-in flows run on your machine. '
  + 'Run `yaac auth update` (or `yaac auth server start`) there.'

function createAuthAgentHub(): {
  setSocket(owner: string, sock: AgentSocketLike): void
  handleDisconnect(owner: string, sock: AgentSocketLike): void
  ingest(owner: string, raw: string): void
  connected(owner: string): boolean
  startLogin(owner: string, tool: AgentTool2): ToolLoginView
  getLogin(owner: string, id: string): ToolLoginView
  sendLoginInput(owner: string, id: string, text: string): ToolLoginView
  cancelLogin(owner: string, id: string): void
  startInstall(owner: string, tool: AgentTool2): ToolInstallView
  getInstall(owner: string, id: string): ToolInstallView
  cancelInstall(owner: string, id: string): void
  clearForTests(): void
} {
  const sockets = new Map<string, AgentSocketLike>()
  const flows = new Map<string, FlowEntry>()

  const send = (owner: string, op: AgentOp): void => {
    sockets.get(owner)?.send(JSON.stringify(op))
  }

  const armLinger = (entry: FlowEntry): void => {
    if (entry.view.status === 'running' || entry.linger) return
    entry.linger = setTimeout(() => flows.delete(entry.view.id), LINGER_MS)
    entry.linger.unref?.()
  }

  const requireAgent = (owner: string): void => {
    if (!sockets.has(owner)) throw new ServerError('AUTH_AGENT_DISCONNECTED', DISCONNECTED_MESSAGE)
  }

  const start = (owner: string, kind: AgentKind, tool: AgentTool2): FlowEntry => {
    requireAgent(owner)
    const view: ToolLoginView = { id: crypto.randomUUID(), tool, status: 'running', output: '' }
    const entry: FlowEntry = { owner, kind, view, linger: null }
    flows.set(view.id, entry)
    send(owner, { op: 'start', id: view.id, kind, tool })
    return entry
  }

  /** The caller's flow; another user's reads as missing. */
  const find = (owner: string, kind: AgentKind, id: string): FlowEntry | undefined => {
    const entry = flows.get(id)
    return entry?.owner === owner && entry.kind === kind ? entry : undefined
  }

  const get = (owner: string, kind: AgentKind, id: string, noun: string): FlowEntry => {
    const entry = find(owner, kind, id)
    if (!entry) throw new ServerError('NOT_FOUND', `No ${noun} "${id}".`)
    return entry
  }

  const cancel = (owner: string, kind: AgentKind, id: string): void => {
    const entry = find(owner, kind, id)
    if (!entry) return
    if (entry.linger) clearTimeout(entry.linger)
    flows.delete(id)
    send(owner, { op: 'cancel', id, kind })
  }

  return {
    setSocket: (owner, sock) => {
      const previous = sockets.get(owner)
      if (previous && previous !== sock) {
        try {
          previous.close(1000, 'replaced by a newer auth server connection')
        } catch { /* already gone */ }
      }
      sockets.set(owner, sock)
      serverLog(`[server] auth agent connected for user ${owner}`)
    },

    handleDisconnect: (owner, sock) => {
      if (sockets.get(owner) !== sock) return // an old, already-replaced connection
      sockets.delete(owner)
      serverLog(`[server] auth agent disconnected for user ${owner}`)
      // The auth server kills its flows on disconnect; mark them failed so
      // pollers stop waiting.
      for (const entry of flows.values()) {
        if (entry.owner === owner && entry.view.status === 'running') {
          entry.view.status = 'error'
          entry.view.error = 'The auth server disconnected mid-flow. Start it again and retry.'
          armLinger(entry)
        }
      }
    },

    ingest: (owner, raw) => {
      const msg = parseAgentViewMsg(raw)
      if (!msg) return
      // Accept only ids minted here for this user, so an auth server can
      // neither create state nor touch another user's flows.
      const entry = find(owner, msg.kind, msg.view.id)
      if (!entry) return
      entry.view = msg.view
      armLinger(entry)
    },

    connected: (owner) => sockets.has(owner),

    startLogin: (owner, tool) => start(owner, 'login', tool).view,
    getLogin: (owner, id) => get(owner, 'login', id, 'sign-in session').view,

    sendLoginInput: (owner, id, text) => {
      const entry = get(owner, 'login', id, 'sign-in session')
      if (entry.view.status !== 'running') {
        throw new ServerError('CONFLICT', 'This sign-in is not accepting input.')
      }
      requireAgent(owner)
      const cleaned = text.trim()
      if (!LOGIN_INPUT_RE.test(cleaned)) {
        throw new ServerError(
          'VALIDATION',
          'Expected the code from the authorize page (letters, digits, "#", "-", "_" only).',
        )
      }
      send(owner, { op: 'input', id, text: cleaned })
      return entry.view
    },

    cancelLogin: (owner, id) => cancel(owner, 'login', id),

    startInstall: (owner, tool) => start(owner, 'install', tool).view,
    getInstall: (owner, id) => get(owner, 'install', id, 'install session').view,
    cancelInstall: (owner, id) => cancel(owner, 'install', id),

    clearForTests: () => {
      for (const entry of flows.values()) {
        if (entry.linger) clearTimeout(entry.linger)
      }
      flows.clear()
      sockets.clear()
    },
  }
}

/** The server's single hub, shared by the routes and the WS upgrade. */
export const authAgentHub = createAuthAgentHub()
