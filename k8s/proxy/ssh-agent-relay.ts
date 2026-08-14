/**
 * ssh-agent forwarding: the transport that lets a worktree pod use the
 * proxy's in-memory agent without a shared filesystem.
 *
 * The agent runs in THIS pod, holding keys the server uploaded over PUT
 * /agent/keys — key bytes are never written to the proxy's disk and never
 * leave it at all. A worktree pod runs a small local forwarder that exposes
 * this listener as the UNIX socket its SSH_AUTH_SOCK names, so an in-pod
 * `git push` gets signatures, never a key.
 *
 * TCP rather than a hostPath UNIX socket shared with the worktree pod: a
 * UNIX socket only rendezvous between pods on the SAME node, which was the
 * last hard single-node assumption in the worktree datapath. Everything else
 * a worktree pod needs from the proxy is already a network hop.
 *
 * Fail-closed, in three independent layers:
 *  1. NetworkPolicy admits this port from worktree pods only (the proxy
 *     ingress policy), so nothing else in the cluster can even connect.
 *  2. The source pod IP must resolve to a worktree through the proxy's
 *     pod-watch — the same identity the transparent listeners trust, and one
 *     a sandboxed workload cannot forge (Calico policies the workload
 *     endpoint's source address).
 *  3. That worktree's registered remote must be an SSH one — exactly the
 *     condition under which the server provisions SSH_AUTH_SOCK in the pod.
 *     It is read from the registration the proxy already holds, so nothing
 *     new rides the wire and worktrees registered by an older server are
 *     gated identically.
 *
 * Even past all three, a connection is a signing oracle for one destination:
 * every identity is added with `ssh-add -h <host>`, so the agent refuses to
 * sign for any other host.
 *
 * And it is an oracle for *only* that: the client→agent direction is parsed,
 * not spliced, and admits two message types — list identities, and sign.
 * Everything else (add, remove, lock, extension) is answered with the
 * agent's own SSH_AGENT_FAILURE and never reaches the agent, so one worktree
 * cannot lock or empty an agent every other worktree shares. The agent→client
 * direction stays a raw pipe: it carries only what the agent chose to answer.
 */

import net from 'node:net'

/**
 * Client→agent message types the relay admits (PROTOCOL.agent): ask which
 * identities exist, and ask for a signature. Those two are the whole of what
 * an ssh client needs from a forwarded agent.
 */
const SSH_AGENTC_REQUEST_IDENTITIES = 11
const SSH_AGENTC_SIGN_REQUEST = 13
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
 * the scp-like `[user@]host:path`. Kept local (rather than reusing the
 * proxy's parseGitRemote) so this module has no dependency on proxy.ts, and
 * because the gate only needs the scheme.
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
  log?: (message: string) => void
  /** Overridable for tests; defaults above. */
  maxConnections?: number
  idleTimeoutMs?: number
}

/**
 * Feed client bytes through the agent-protocol framing (`uint32 length`,
 * then a type byte), handing whole admitted messages to `forward` and
 * answering everything else with SSH_AGENT_FAILURE via `refuse`. Returns the
 * chunk consumer; `fail` ends the connection on a frame that cannot be the
 * agent protocol.
 *
 * Pipelining note: a refusal is answered immediately while an admitted
 * message is still in flight to the agent, so a client that pipelined both
 * could see the replies out of order. Real clients (ssh, ssh-add) keep one
 * request outstanding, and a client that pipelines a refused op is
 * misbehaving by construction.
 */
export function createAgentRequestFilter(handlers: {
  forward: (message: Buffer) => void
  refuse: (type: number) => void
  fail: (reason: string) => void
}): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0)
  return (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.length < 4) return
      const length = buf.readUInt32BE(0)
      if (length === 0 || length > AGENT_MAX_MESSAGE_BYTES) {
        handlers.fail(`implausible message length ${length}`)
        return
      }
      if (buf.length < 4 + length) return
      const message = buf.subarray(0, 4 + length)
      buf = buf.subarray(4 + length)
      const type = message[4]
      if (type === SSH_AGENTC_REQUEST_IDENTITIES || type === SSH_AGENTC_SIGN_REQUEST) {
        handlers.forward(message)
      } else {
        handlers.refuse(type)
      }
    }
  }
}

/**
 * The listener. One accepted connection = one splice to the agent socket;
 * refusals destroy the socket without writing a byte, which an ssh client
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
      // Client → agent is FILTERED, not piped (see the module doc). Backpressure
      // rides the socket: a full agent write pauses the client until it drains.
      const feed = createAgentRequestFilter({
        forward: (message) => {
          if (!agent.write(message)) socket.pause()
        },
        refuse: (type) => {
          log(`[proxy] ssh-agent: refused message type ${type} from worktree ${worktree}...`)
          socket.write(FAILURE_MESSAGE)
        },
        fail: (reason) => {
          log(`[proxy] ssh-agent: dropping worktree ${worktree}... — ${reason}`)
          socket.destroy()
        },
      })
      agent.on('drain', () => socket.resume())
      agent.on('connect', () => {
        connected = true
        socket.on('data', feed)
        // Carry the client's half-close to the agent. `pipe` would have done
        // this; the filter must do it by hand, or a finished exchange holds
        // an agent fd open until the idle reaper gets to it.
        socket.on('end', () => agent.end())
        // Agent → client stays a raw pipe: it carries only what the agent
        // itself chose to answer.
        agent.pipe(socket)
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
