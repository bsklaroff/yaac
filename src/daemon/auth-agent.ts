import crypto from 'node:crypto'
import { DaemonError } from '@/daemon/errors'
import { daemonLog } from '@/daemon/log'
import type { ToolInstallView, ToolLoginView } from '@/shared/types'

/**
 * Relay hub between the webapp/CLI sign-in routes and the auth daemon on
 * the user's machine. The vendor login/install flows run over there (the
 * browser and the vendors' localhost OAuth callbacks live on the user's
 * machine, not necessarily the daemon host); this hub only forwards ops
 * down one outbound WebSocket and caches the views the agent pushes back,
 * so the existing polled routes keep their shapes.
 *
 * Deliberately minimal protocol — no request/response correlation:
 *  - down (daemon → agent):  {op:'start'|'input'|'cancel', id, ...}
 *  - up   (agent → daemon):  {op:'view', kind, view} on every change
 * Flow ids are minted here so a start can return a synthetic 'running'
 * view synchronously; the agent creates its session under the same id.
 * Credentials never transit this hub — on success the agent PUTs the
 * bundle to /auth/:tool itself.
 */

export type AgentKind = 'login' | 'install'
export type AgentTool2 = 'claude' | 'codex'

export type AgentOp =
  | { op: 'start'; id: string; kind: AgentKind; tool: AgentTool2 }
  | { op: 'input'; id: string; text: string }
  | { op: 'cancel'; id: string; kind: AgentKind }

export interface AgentViewMsg {
  op: 'view'
  kind: AgentKind
  view: ToolLoginView | ToolInstallView
}

/** Parse an upstream agent frame; null for anything unrecognized. */
export function parseAgentViewMsg(raw: string): AgentViewMsg | null {
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

/** Same whitelist the agent enforces before writing to the login PTY;
 *  checked here too so bad paste input fails fast with a message. */
const LOGIN_INPUT_RE = /^[A-Za-z0-9_#-]{1,512}$/

/** How long a finished flow stays pollable (mirrors the agent's linger). */
const LINGER_MS = 5 * 60 * 1000

export interface AgentSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
}

interface FlowEntry {
  kind: AgentKind
  view: ToolLoginView | ToolInstallView
  linger: ReturnType<typeof setTimeout> | null
}

const DISCONNECTED_MESSAGE =
  'No auth daemon is connected — sign-in flows run on your machine. '
  + 'Run `yaac auth update` (or `yaac auth daemon start`) there.'

export function createAuthAgentHub(): {
  setSocket(sock: AgentSocketLike): void
  handleDisconnect(sock: AgentSocketLike): void
  ingest(raw: string): void
  connected(): boolean
  startLogin(tool: AgentTool2): ToolLoginView
  getLogin(id: string): ToolLoginView
  sendLoginInput(id: string, text: string): ToolLoginView
  cancelLogin(id: string): void
  startInstall(tool: AgentTool2): ToolInstallView
  getInstall(id: string): ToolInstallView
  cancelInstall(id: string): void
  clearForTests(): void
} {
  let socket: AgentSocketLike | null = null
  const flows = new Map<string, FlowEntry>()

  const send = (op: AgentOp): void => {
    socket?.send(JSON.stringify(op))
  }

  const armLinger = (entry: FlowEntry): void => {
    if (entry.view.status === 'running' || entry.linger) return
    entry.linger = setTimeout(() => flows.delete(entry.view.id), LINGER_MS)
    entry.linger.unref?.()
  }

  const requireAgent = (): void => {
    if (!socket) throw new DaemonError('AUTH_AGENT_DISCONNECTED', DISCONNECTED_MESSAGE)
  }

  const start = (kind: AgentKind, tool: AgentTool2): FlowEntry => {
    requireAgent()
    const view: ToolLoginView = { id: crypto.randomUUID(), tool, status: 'running', output: '' }
    const entry: FlowEntry = { kind, view, linger: null }
    flows.set(view.id, entry)
    send({ op: 'start', id: view.id, kind, tool })
    return entry
  }

  const get = (kind: AgentKind, id: string, noun: string): FlowEntry => {
    const entry = flows.get(id)
    if (!entry || entry.kind !== kind) {
      throw new DaemonError('NOT_FOUND', `No ${noun} "${id}".`)
    }
    return entry
  }

  const cancel = (kind: AgentKind, id: string): void => {
    const entry = flows.get(id)
    if (!entry || entry.kind !== kind) return
    if (entry.linger) clearTimeout(entry.linger)
    flows.delete(id)
    send({ op: 'cancel', id, kind })
  }

  return {
    setSocket: (sock) => {
      if (socket && socket !== sock) {
        try {
          socket.close(1000, 'replaced by a newer auth daemon connection')
        } catch { /* already gone */ }
      }
      socket = sock
      daemonLog('[daemon] auth agent connected')
    },

    handleDisconnect: (sock) => {
      if (socket !== sock) return // an old, already-replaced connection
      socket = null
      daemonLog('[daemon] auth agent disconnected')
      // In-flight flows died with the agent (it kills its subprocesses on
      // disconnect); reflect that so pollers stop waiting.
      for (const entry of flows.values()) {
        if (entry.view.status === 'running') {
          entry.view.status = 'error'
          entry.view.error = 'The auth daemon disconnected mid-flow. Start it again and retry.'
          armLinger(entry)
        }
      }
    },

    ingest: (raw) => {
      const msg = parseAgentViewMsg(raw)
      if (!msg) return
      const entry = flows.get(msg.view.id)
      // Only ids this hub minted are accepted — the agent can't create
      // daemon-side state on its own.
      if (!entry || entry.kind !== msg.kind) return
      entry.view = msg.view
      armLinger(entry)
    },

    connected: () => socket !== null,

    startLogin: (tool) => start('login', tool).view as ToolLoginView,
    getLogin: (id) => get('login', id, 'sign-in session').view as ToolLoginView,

    sendLoginInput: (id, text) => {
      const entry = get('login', id, 'sign-in session')
      if (entry.view.status !== 'running') {
        throw new DaemonError('CONFLICT', 'This sign-in is not accepting input.')
      }
      requireAgent()
      const cleaned = text.trim()
      if (!LOGIN_INPUT_RE.test(cleaned)) {
        throw new DaemonError(
          'VALIDATION',
          'Expected the code from the authorize page (letters, digits, "#", "-", "_" only).',
        )
      }
      send({ op: 'input', id, text: cleaned })
      return entry.view as ToolLoginView
    },

    cancelLogin: (id) => cancel('login', id),

    startInstall: (tool) => start('install', tool).view as ToolInstallView,
    getInstall: (id) => get('install', id, 'install session').view as ToolInstallView,
    cancelInstall: (id) => cancel('install', id),

    clearForTests: () => {
      for (const entry of flows.values()) {
        if (entry.linger) clearTimeout(entry.linger)
      }
      flows.clear()
      socket = null
    },
  }
}

/** The daemon's one hub — routes and the WS upgrade share it. */
export const authAgentHub = createAuthAgentHub()
