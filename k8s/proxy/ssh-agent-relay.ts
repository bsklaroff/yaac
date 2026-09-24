/**
 * ssh-agent forwarding: the transport that lets a worktree pod use the
 * proxy's in-memory agent without a shared filesystem.
 *
 * The agent runs in THIS pod, holding keys loaded from the credentials
 * Secret (agent-keys.ts) — key bytes are never written to the proxy's disk
 * and never leave it at all. A worktree pod runs a small local forwarder that exposes
 * this listener as the UNIX socket its SSH_AUTH_SOCK names, so an in-pod
 * `git push` gets signatures, never a key.
 *
 * TCP rather than a hostPath UNIX socket shared with the worktree pod: a
 * UNIX socket only rendezvous between pods on the SAME node, which was the
 * last hard single-node assumption in the worktree datapath. Everything else
 * a worktree pod needs from the proxy is already a network hop.
 *
 * Fail-closed, in independent layers:
 *  1. NetworkPolicy admits this port from worktree pods only (the proxy
 *     ingress policy), so nothing else in the cluster can even connect.
 *  2. The source pod IP must resolve to a worktree through the proxy's
 *     pod-watch — the same identity the transparent listeners trust, and one
 *     a sandboxed workload cannot forge (Calico policies the workload
 *     endpoint's source address).
 *  3. That worktree's registered remote must be an SSH one — exactly the
 *     condition under which the server provisions SSH_AUTH_SOCK in the pod.
 *     It is read from the registration the proxy already holds, so nothing
 *     new rides the wire.
 *  4. A connection only ever sees the keys assigned to its worktree's
 *     project. The agent holds every project's keys, so both directions are
 *     parsed: an identities answer is rewritten to list only that project's
 *     keys, and a sign request naming any other key is answered with
 *     SSH_AGENT_FAILURE here and never reaches the agent. The set is looked
 *     up per message rather than per connection, so a reassignment applies
 *     to an open connection's next request.
 *
 * Even past all four, a connection is a signing oracle for its project's
 * destinations only: every identity is added with one `ssh-add -h <host>`
 * per host among the projects it is assigned to (agent-keys.ts), so the
 * agent refuses to sign for any other host.
 *
 * And it is an oracle for *only* that: the client→agent direction admits
 * three messages — list identities, sign, and the one extension that makes
 * the destination constraint enforceable, `session-bind@openssh.com`, by
 * which an ssh client tells the agent which host it is talking to before it
 * asks for a signature. An agent will not sign with a constrained key on a
 * session that was never bound, so refusing the bind would leave every key
 * here permanently unsignable from a worktree; forwarding it narrows the
 * oracle rather than widening it. Everything else (add, remove, lock, any
 * other extension) is answered with the agent's own SSH_AGENT_FAILURE and
 * never reaches the agent, so one worktree cannot lock or empty an agent
 * every other worktree shares.
 */

import net from 'node:net'

/**
 * Client→agent message types the relay admits (PROTOCOL.agent): ask which
 * identities exist, ask for a signature, and — for one extension only —
 * bind the session to its destination. That is the whole of what an ssh
 * client needs from a forwarded agent holding constrained keys.
 */
const SSH_AGENTC_REQUEST_IDENTITIES = 11
const SSH_AGENTC_SIGN_REQUEST = 13
const SSH_AGENTC_EXTENSION = 27
/** The agent's reply to REQUEST_IDENTITIES: `uint32 nkeys`, then per key
 *  `string key_blob, string comment`. The one reply the relay rewrites. */
const SSH_AGENT_IDENTITIES_ANSWER = 12
/** The extension name an ssh client sends first on every connection to
 *  the agent: `string "session-bind@openssh.com"`, then the host key, the
 *  session id and the server's signature. Only this extension passes. */
const SESSION_BIND = Buffer.from('session-bind@openssh.com')
/** The refusal an agent itself returns for a request it won't serve. */
const SSH_AGENT_FAILURE = 5
const FAILURE_MESSAGE = Buffer.from([0, 0, 0, 1, SSH_AGENT_FAILURE])

/**
 * OpenSSH's own AGENT_MAX_LEN. A frame claiming more than this is not the
 * agent protocol, so the connection is dropped rather than buffered.
 */
const AGENT_MAX_MESSAGE_BYTES = 256 * 1024
/** In-flight connections the listener will hold; beyond it, new dials are
 *  dropped so one worktree cannot exhaust the proxy's fds. */
const DEFAULT_MAX_CONNECTIONS = 64
/** Idle time after which a connection is reaped (both directions). An agent
 *  exchange is a sub-second request/response; anything quiet for this long
 *  is abandoned. */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000

export type AgentGateVerdict =
  | { ok: true; worktreeId: string }
  | { ok: false; reason: string }

/**
 * Decide whether a connection from `worktree` may talk to the agent, given
 * the repo URL that worktree is registered with. Pure, so the policy is
 * testable without a socket; the listener below is the only caller.
 */
export function sshAgentGate(
  worktreeId: string | undefined,
  repoUrl: string | undefined,
): AgentGateVerdict {
  if (!worktreeId) return { ok: false, reason: 'source is not a known worktree pod' }
  if (!isSshRemote(repoUrl)) {
    return { ok: false, reason: 'worktree has no SSH remote registered' }
  }
  return { ok: true, worktreeId }
}

/**
 * True for the remote forms git treats as SSH: an explicit `ssh://` URL or
 * the scp-like `[user@]host:path`. Kept here so this module has no
 * dependency on proxy.ts, and because the gate only needs the scheme.
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
  /** Source IP → worktree, via the proxy's pod-watch index. */
  resolveWorktree: (ip: string) => Promise<string | undefined>
  /** The repo URL a worktree is registered with, if any. */
  repoUrlFor: (worktreeId: string) => string | undefined
  /** The keys (base64 key blobs) a worktree may list and sign with — its
   *  project's. Asked per message, so an assignment change is live. */
  allowedKeysFor: (worktreeId: string) => Set<string>
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
 * Feed client bytes through the agent-protocol framing, handing whole
 * admitted messages to `forward` and answering everything else with
 * SSH_AGENT_FAILURE via `refuse`: a message type outside the allowlist, or
 * a sign request whose key blob (the `string` right after the type byte)
 * `allowKey` rejects. Returns the chunk consumer.
 *
 * Pipelining note: a refusal is answered immediately while an admitted
 * message is still in flight to the agent, so a client that pipelined both
 * could see the replies out of order. Real clients (ssh, ssh-add) keep one
 * request outstanding, and a client that pipelines a refused op is
 * misbehaving by construction.
 */
export function createAgentRequestFilter(handlers: {
  allowKey: (blob: Buffer) => boolean
  forward: (message: Buffer) => void
  refuse: (type: number, reason: string) => void
  fail: (reason: string) => void
}): (chunk: Buffer) => void {
  return agentFrames((message) => {
    const type = message[4]
    if (type === SSH_AGENTC_SIGN_REQUEST) {
      const blob = readString(message, 5)?.value
      if (blob && handlers.allowKey(blob)) handlers.forward(message)
      else handlers.refuse(type, 'sign request for a key not assigned to its project')
    } else if (type === SSH_AGENTC_REQUEST_IDENTITIES
      || (type === SSH_AGENTC_EXTENSION && isSessionBind(message))) {
      handlers.forward(message)
    } else {
      handlers.refuse(type, 'message type not admitted')
    }
  }, handlers.fail)
}

/** Whether a whole extension frame names `session-bind@openssh.com` — the
 *  `string` right after the type byte. */
function isSessionBind(message: Buffer): boolean {
  return readString(message, 5)?.value.equals(SESSION_BIND) ?? false
}

/**
 * Feed agent bytes through the same framing, handing each whole reply to
 * `deliver` — an identities answer rewritten to list only the keys
 * `allowKey` admits, everything else unchanged. An identities answer that
 * does not parse fails the stream rather than passing through unfiltered.
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
 * The listener. One accepted connection = one agent-socket connection,
 * filtered both ways; refusals destroy the socket without writing a byte, which an ssh client
 * reports as "error connecting to agent" and falls through to its other
 * identity sources.
 */
export function createSshAgentServer(deps: SshAgentServerDeps): net.Server {
  const log = deps.log ?? ((m: string): void => { console.log(m) })
  const maxConnections = deps.maxConnections ?? DEFAULT_MAX_CONNECTIONS
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  let live = 0
  return net.createServer({ allowHalfOpen: true }, (socket) => {
    // No 'data' listener before the filter is attached: the socket stays
    // paused, so the request bytes an ssh client pipelines straight behind
    // its connect are buffered by the stream rather than discarded while the
    // gate resolves.
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
      const resolved = peer ? await deps.resolveWorktree(peer) : undefined
      const verdict = sshAgentGate(resolved, resolved ? deps.repoUrlFor(resolved) : undefined)
      if (!verdict.ok) {
        log(`[proxy] BLOCKED ssh-agent from ${peer || '(unknown)'}: ${verdict.reason}`)
        socket.destroy()
        return
      }
      if (socket.destroyed) return
      const worktree = verdict.worktreeId.slice(0, 8)
      const agent = net.connect({ path: deps.agentSock, allowHalfOpen: true })
      agent.setTimeout(idleTimeoutMs, () => agent.destroy())
      let connected = false
      const allowKey = (blob: Buffer): boolean =>
        deps.allowedKeysFor(verdict.worktreeId).has(blob.toString('base64'))
      const fail = (reason: string): void => {
        log(`[proxy] ssh-agent: dropping worktree ${worktree}... — ${reason}`)
        socket.destroy()
      }
      // Both directions are FILTERED, not piped (see the module doc).
      // Backpressure rides the sockets: a full write pauses the other side
      // until it drains.
      const feedRequest = createAgentRequestFilter({
        allowKey,
        forward: (message) => {
          if (!agent.write(message)) socket.pause()
        },
        refuse: (type, reason) => {
          log(`[proxy] ssh-agent: refused message type ${type} from worktree ${worktree}... — ${reason}`)
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
        // Carry each side's half-close to the other, as `pipe` would: a
        // finished exchange must not hold an agent fd open until the idle
        // reaper gets to it.
        socket.on('end', () => agent.end())
        agent.on('end', () => socket.end())
      })
      agent.on('error', (err: NodeJS.ErrnoException) => {
        if (!connected) {
          log(`[proxy] ssh-agent dial failed for worktree ${worktree}...: ${err.code ?? err.message}`)
        }
        socket.destroy()
      })
      agent.on('close', () => socket.destroy())
      socket.on('close', () => agent.destroy())
    })()
  })
}
