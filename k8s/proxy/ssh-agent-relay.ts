/**
 * ssh-agent forwarding over TCP, so a workspace pod can use the proxy's
 * in-memory agent (keys loaded by agent-keys.ts, never written to disk). A
 * forwarder in the workspace pod exposes this listener as its SSH_AUTH_SOCK,
 * so `git push` gets signatures, never keys. TCP rather than a shared UNIX
 * socket works across nodes. See docs/git-credentials.md.
 *
 * Access is checked in layers:
 *  1. NetworkPolicy admits this port from workspace pods only.
 *  2. The source pod IP must map to a workspace via pod-watch. This port
 *     gets no PP2 header, so the source IP is the whole identity; it is
 *     trustworthy because Calico drops packets whose source address is not
 *     the sending pod's own.
 *  3. That workspace's registered remote must be an SSH one.
 *  4. Both directions are parsed so a connection sees only the keys its
 *     owner granted its project: identity lists are filtered, and a sign
 *     request is refused for any other key, and unless every host key the
 *     connection bound (`session-bind@openssh.com`) is one that key is
 *     granted for in this project. The grants are looked up per message, so
 *     reassignments apply to open connections.
 *
 * Each key is added with `ssh-add -h <host>` per host any grant names, so the
 * agent signs only for those hosts. That set is the union over every owner
 * and project holding the key, which is why the relay checks the bound host
 * itself. Clients may send only list, sign, and the session bind. Everything
 * else (add, remove, lock, other extensions) is refused, so one workspace
 * can't lock or empty the shared agent.
 */

import net from 'node:net'

/** Client→agent message types the relay admits (PROTOCOL.agent). */
const SSH_AGENTC_REQUEST_IDENTITIES = 11
const SSH_AGENTC_SIGN_REQUEST = 13
const SSH_AGENTC_EXTENSION = 27
/** The agent's reply to REQUEST_IDENTITIES: `uint32 nkeys`, then per key
 *  `string key_blob, string comment`. The only reply the relay rewrites. */
const SSH_AGENT_IDENTITIES_ANSWER = 12
/** The only extension allowed through. An ssh client sends it first on each
 *  connection, followed by the host key, session id and server signature. */
const SESSION_BIND = Buffer.from('session-bind@openssh.com')
/** The refusal an agent itself returns for a request it won't serve. */
const SSH_AGENT_FAILURE = 5
const FAILURE_MESSAGE = Buffer.from([0, 0, 0, 1, SSH_AGENT_FAILURE])

/** OpenSSH's AGENT_MAX_LEN. A larger frame drops the connection. */
const AGENT_MAX_MESSAGE_BYTES = 256 * 1024
/** In-flight connections the listener will hold; beyond it, new dials are
 *  dropped so one workspace cannot exhaust the proxy's fds. */
const DEFAULT_MAX_CONNECTIONS = 64
/** Idle time after which a connection is closed. Agent exchanges take
 *  well under a second. */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000

export type AgentGateVerdict =
  | { ok: true; workspaceId: string }
  | { ok: false; reason: string }

/**
 * Whether a connection from `workspace` may talk to the agent, given the
 * repo URL it is registered with.
 */
export function sshAgentGate(
  workspaceId: string | undefined,
  repoUrl: string | undefined,
): AgentGateVerdict {
  if (!workspaceId) return { ok: false, reason: 'source is not a known workspace pod' }
  if (!isSshRemote(repoUrl)) {
    return { ok: false, reason: 'workspace has no SSH remote registered' }
  }
  return { ok: true, workspaceId }
}

/**
 * True for the remote forms git treats as SSH: an `ssh://` URL or the
 * scp-like `[user@]host:path`.
 */
export function isSshRemote(remoteUrl: string | undefined): boolean {
  if (!remoteUrl) return false
  if (/^ssh:\/\//i.test(remoteUrl)) return true
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remoteUrl)) return false
  return /^(?:[\w._-]+@)?[\w.-]+:(?!\/)./.test(remoteUrl)
}

export interface SshAgentServerDeps {
  /** Filesystem path of the pod-local ssh-agent socket. */
  agentSock: string
  /** Source IP → workspace, via the proxy's pod-watch index. */
  resolveWorkspace: (ip: string) => Promise<string | undefined>
  /** The repo URL a workspace is registered with, if any. */
  repoUrlFor: (workspaceId: string) => string | undefined
  /** The key blobs (base64) a workspace may list and sign with, each with
   *  the host keys (base64) it may sign for. */
  grantsFor: (workspaceId: string) => Map<string, Set<string>>
  log?: (message: string) => void
  /** Overridable for tests; defaults above. */
  maxConnections?: number
  idleTimeoutMs?: number
}

/**
 * Split a byte stream into whole agent-protocol messages (`uint32 length`,
 * then a type byte and body), handing each to `onMessage`; `fail` ends the
 * stream on a frame that cannot be the agent protocol.
 */
function agentFrames(
  onMessage: (message: Buffer) => void,
  fail: (reason: string) => void,
): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0)
  return (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.length < 4) return
      const length = buf.readUInt32BE(0)
      if (length === 0 || length > AGENT_MAX_MESSAGE_BYTES) {
        fail(`implausible message length ${length}`)
        return
      }
      if (buf.length < 4 + length) return
      const message = buf.subarray(0, 4 + length)
      buf = buf.subarray(4 + length)
      onMessage(message)
    }
  }
}

/** The wire `string` at `offset` in `message` and the offset past it, or
 *  null when it overruns the message. */
function readString(message: Buffer, offset: number): { value: Buffer; next: number } | null {
  if (offset + 4 > message.length) return null
  const next = offset + 4 + message.readUInt32BE(offset)
  return next > message.length ? null : { value: message.subarray(offset + 4, next), next }
}

/**
 * Returns a consumer for client bytes. Whole admitted messages go to
 * `forward`; a disallowed type, a malformed bind, or a sign request
 * `allowSign` rejects gets SSH_AGENT_FAILURE via `refuse`. `allowSign` is
 * handed every host key this connection has bound so far.
 *
 * A refusal is sent immediately, so a client that pipelines requests could
 * see replies out of order. Real clients keep one request outstanding.
 */
export function createAgentRequestFilter(handlers: {
  allowSign: (keyBlob: Buffer, boundHostKeys: Buffer[]) => boolean
  forward: (message: Buffer) => void
  refuse: (type: number, reason: string) => void
  fail: (reason: string) => void
}): (chunk: Buffer) => void {
  const bound: Buffer[] = []
  return agentFrames((message) => {
    const type = message[4]
    if (type === SSH_AGENTC_SIGN_REQUEST) {
      const blob = readString(message, 5)?.value
      if (blob && handlers.allowSign(blob, bound)) handlers.forward(message)
      else handlers.refuse(type, 'sign request for a key or host its project is not granted')
    } else if (type === SSH_AGENTC_REQUEST_IDENTITIES) {
      handlers.forward(message)
    } else if (type === SSH_AGENTC_EXTENSION && isSessionBind(message)) {
      // After the name: the server's host key, then session id and signature.
      const hostKey = readString(message, 5 + 4 + SESSION_BIND.length)?.value
      if (!hostKey) {
        handlers.refuse(type, 'session bind without a host key')
        return
      }
      bound.push(hostKey)
      handlers.forward(message)
    } else {
      handlers.refuse(type, 'message type not admitted')
    }
  }, handlers.fail)
}

/** Whether a whole extension frame names `session-bind@openssh.com`. */
function isSessionBind(message: Buffer): boolean {
  return readString(message, 5)?.value.equals(SESSION_BIND) ?? false
}

/**
 * Returns a consumer for agent bytes. Each whole reply goes to `deliver`,
 * with identity lists filtered to the keys `allowKey` admits. An identity
 * list that doesn't parse fails the stream instead of passing unfiltered.
 */
export function createAgentReplyFilter(handlers: {
  allowKey: (blob: Buffer) => boolean
  deliver: (message: Buffer) => void
  fail: (reason: string) => void
}): (chunk: Buffer) => void {
  return agentFrames((message) => {
    if (message[4] !== SSH_AGENT_IDENTITIES_ANSWER) {
      handlers.deliver(message)
      return
    }
    const filtered = filterIdentitiesAnswer(message, handlers.allowKey)
    if (filtered) handlers.deliver(filtered)
    else handlers.fail('malformed identities answer from the agent')
  }, handlers.fail)
}

function filterIdentitiesAnswer(message: Buffer, allowKey: (blob: Buffer) => boolean): Buffer | null {
  if (message.length < 9) return null
  const count = message.readUInt32BE(5)
  const kept: Buffer[] = []
  let offset = 9
  for (let i = 0; i < count; i++) {
    const blob = readString(message, offset)
    const comment = blob && readString(message, blob.next)
    if (!blob || !comment) return null
    if (allowKey(blob.value)) kept.push(message.subarray(offset, comment.next))
    offset = comment.next
  }
  if (offset !== message.length) return null
  const body = Buffer.concat(kept)
  const out = Buffer.alloc(9 + body.length)
  out.writeUInt32BE(5 + body.length, 0)
  out.writeUInt8(SSH_AGENT_IDENTITIES_ANSWER, 4)
  out.writeUInt32BE(kept.length, 5)
  body.copy(out, 9)
  return out
}

/**
 * The listener: each accepted connection gets its own agent-socket
 * connection, filtered both ways. A refused connection is closed without a
 * reply, so the ssh client falls back to its other identity sources.
 */
export function createSshAgentServer(deps: SshAgentServerDeps): net.Server {
  const log = deps.log ?? ((m: string): void => { console.log(m) })
  const maxConnections = deps.maxConnections ?? DEFAULT_MAX_CONNECTIONS
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  let live = 0
  return net.createServer({ allowHalfOpen: true }, (socket) => {
    // No 'data' listener yet, so bytes sent while the gate resolves stay
    // buffered.
    const peer = (socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    if (live >= maxConnections) {
      log(`[proxy] ssh-agent: refusing ${peer || '(unknown)'} — ${live} connections in flight`)
      socket.destroy()
      return
    }
    live++
    socket.once('close', () => { live-- })
    socket.setTimeout(idleTimeoutMs, () => socket.destroy())
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'ECONNRESET') {
        log(`[proxy] ssh-agent socket error from ${peer || '(unknown)'}: ${err.message}`)
      }
    })
    void (async () => {
      const resolved = peer ? await deps.resolveWorkspace(peer) : undefined
      const verdict = sshAgentGate(resolved, resolved ? deps.repoUrlFor(resolved) : undefined)
      if (!verdict.ok) {
        log(`[proxy] BLOCKED ssh-agent from ${peer || '(unknown)'}: ${verdict.reason}`)
        socket.destroy()
        return
      }
      if (socket.destroyed) return
      const workspace = verdict.workspaceId.slice(0, 8)
      const agent = net.connect({ path: deps.agentSock, allowHalfOpen: true })
      agent.setTimeout(idleTimeoutMs, () => agent.destroy())
      let connected = false
      const allowKey = (blob: Buffer): boolean =>
        deps.grantsFor(verdict.workspaceId).has(blob.toString('base64'))
      // A key signs only once the connection is bound, and only for hosts
      // this workspace's grant of it names.
      const allowSign = (blob: Buffer, boundHostKeys: Buffer[]): boolean => {
        const hostKeys = deps.grantsFor(verdict.workspaceId).get(blob.toString('base64'))
        return hostKeys !== undefined && boundHostKeys.length > 0
          && boundHostKeys.every((h) => hostKeys.has(h.toString('base64')))
      }
      const fail = (reason: string): void => {
        log(`[proxy] ssh-agent: dropping workspace ${workspace}... — ${reason}`)
        socket.destroy()
      }
      // Filtered, not piped; a full write pauses the other side until drain.
      const feedRequest = createAgentRequestFilter({
        allowSign,
        forward: (message) => {
          if (!agent.write(message)) socket.pause()
        },
        refuse: (type, reason) => {
          log(`[proxy] ssh-agent: refused message type ${type} from workspace ${workspace}... — ${reason}`)
          socket.write(FAILURE_MESSAGE)
        },
        fail,
      })
      const feedReply = createAgentReplyFilter({
        allowKey,
        deliver: (message) => {
          if (!socket.write(message)) agent.pause()
        },
        fail,
      })
      agent.on('drain', () => socket.resume())
      socket.on('drain', () => agent.resume())
      agent.on('connect', () => {
        connected = true
        socket.on('data', feedRequest)
        agent.on('data', feedReply)
        // Propagate half-close, as `pipe` would, so agent fds free promptly.
        socket.on('end', () => agent.end())
        agent.on('end', () => socket.end())
      })
      agent.on('error', (err: NodeJS.ErrnoException) => {
        if (!connected) {
          log(`[proxy] ssh-agent dial failed for workspace ${workspace}...: ${err.code ?? err.message}`)
        }
        socket.destroy()
      })
      agent.on('close', () => socket.destroy())
      socket.on('close', () => agent.destroy())
    })()
  })
}
