/**
 * streamd — the in-pod stream daemon that lets the yaac server reach a
 * workspace pod over plain TCP (via the proxy relay) instead of kubectl exec.
 * Baked into the base image at /opt/yaac/streamd and started by the pod's
 * setup; listens on the pod IP.
 *
 * Every connection starts with ONE JSON handshake line:
 *   {"token": "<streamToken>", "kind": "pty"|"ctrl"|"exec"|"tcp", ...params}
 * answered by one JSON reply line ({"ok":true} or {"ok":false,"error"}),
 * after which the stream's payload flows:
 *
 * - tcp  {port}         raw byte splice to localhost:<port>, dialed in-pod
 *                       so localhost-bound dev servers are reachable.
 * - ctrl {cmd: [argv]}  spawn argv with piped stdio, no TTY; stdin/stdout
 *                       spliced raw (tmux control mode is a line
 *                       protocol). Socket close ⇔ process kill/exit.
 * - exec {cmd: [argv]}  one-shot: run argv, then send a single JSON line
 *                       {exitCode, stdout, stderr} (bounded) and close.
 * - pty  {cmd, cols, rows}  spawn argv under a PTY; framed both ways
 *                       (see framing.js). Resize frames drive TIOCSWINSZ.
 * - ports {}            push the pod's localhost-reachable LISTEN ports
 *                       (see ports.js) as JSON lines {ports:[...]}; see
 *                       handlePorts.
 *
 * The token is per workspace (derived from the install's proxy secret),
 * handed to the pod as YAAC_STREAM_TOKEN. It is defense in depth alongside
 * the ingress NetworkPolicy; a leaked token opens only its own pod.
 */

import net from 'node:net'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import * as pty from '@lydell/node-pty'
import { FRAME_DATA, FRAME_RESIZE, FRAME_SIGNAL, FRAME_EXIT, FrameParser, encodeFrame } from './framing.js'
import { createOutputBatcher } from './batcher.js'
import { readListeningPorts } from './ports.js'

export const DEFAULT_STREAM_PORT = 10300

/** Handshake-line cap + deadline (it precedes any payload byte). */
const HANDSHAKE_MAX_BYTES = 16 * 1024
const HANDSHAKE_TIMEOUT_MS = 10_000
/** Cap on concurrent streams, so a runaway client cannot exhaust the pod. */
const MAX_STREAMS = 128
/** Per-stream cap on buffered exec output. */
const EXEC_OUTPUT_MAX_BYTES = 4 * 1024 * 1024
/** Grace between SIGTERM on socket close and the follow-up SIGKILL. */
const CHILD_KILL_GRACE_MS = 2_000
/** How often a `ports` stream re-reads /proc/net for listener changes. */
const PORTS_POLL_MS = 2_000
/** A `ports` stream re-sends an unchanged set at this cadence so the
 *  server can tell a quiet pod from a dead stream. */
const PORTS_KEEPALIVE_MS = 30_000

const SIGNAL_NAME = /^SIG[A-Z0-9]{1,12}$/

function timingSafeStrEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

function isArgv(cmd) {
  return Array.isArray(cmd) && cmd.length > 0 && cmd.every((c) => typeof c === 'string')
}

/** Kill a piped child gently, then hard after the grace. */
function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try { child.kill('SIGTERM') } catch { /* already gone */ }
  const hard = setTimeout(() => {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }, CHILD_KILL_GRACE_MS)
  hard.unref()
  child.once('exit', () => clearTimeout(hard))
}

function handleTcp(socket, params, leftover) {
  const port = params.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'tcp: invalid port' }
  }
  // 'localhost' reaches servers bound to either 127.0.0.1 or ::1.
  const target = net.connect({ port, host: 'localhost', allowHalfOpen: true })
  target.setNoDelay(true)
  // Buffer client bytes until the dial lands. The socket is already in
  // flowing mode, so data with no listener would be discarded.
  let pending = leftover
  const buffer = (chunk) => { pending = Buffer.concat([pending, chunk]) }
  socket.on('data', buffer)
  target.on('connect', () => {
    socket.removeListener('data', buffer)
    if (pending.length > 0) target.write(pending)
    socket.pipe(target)
    target.pipe(socket)
  })
  target.on('error', () => socket.destroy())
  target.on('close', () => socket.destroy())
  socket.on('close', () => target.destroy())
  socket.on('error', () => target.destroy())
  return { ok: true }
}

function handleCtrl(socket, params, leftover) {
  if (!isArgv(params.cmd)) return { ok: false, error: 'ctrl: cmd must be a non-empty argv array' }
  const child = spawn(params.cmd[0], params.cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
  child.on('error', () => socket.destroy())
  // Drain stderr so the child cannot block on a full pipe.
  child.stderr.resume()
  if (leftover.length > 0) child.stdin.write(leftover)
  socket.pipe(child.stdin)
  child.stdout.pipe(socket)
  child.stdin.on('error', () => socket.destroy())
  // destroySoon flushes output, then closes even if the peer never
  // half-closes.
  child.on('exit', () => socket.destroySoon())
  socket.on('close', () => killChild(child))
  socket.on('error', () => killChild(child))
  return { ok: true }
}

function handleExec(socket, params) {
  if (!isArgv(params.cmd)) return { ok: false, error: 'exec: cmd must be a non-empty argv array' }
  const child = spawn(params.cmd[0], params.cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let truncated = false
  const collect = (current, chunk) => {
    if (current.length + chunk.length > EXEC_OUTPUT_MAX_BYTES) {
      truncated = true
      return current + chunk.toString('utf8').slice(0, EXEC_OUTPUT_MAX_BYTES - current.length)
    }
    return current + chunk.toString('utf8')
  }
  child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk) })
  child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk) })
  child.on('error', (err) => {
    // spawn itself failed (ENOMEM, EMFILE). `spawnFailed` lets the server
    // tell this from a real command-not-found, which also exits 127.
    socket.end(JSON.stringify({
      exitCode: 127, spawnFailed: true, stdout: '', stderr: String(err.message),
    }) + '\n')
  })
  child.on('close', (code, signal) => {
    const exitCode = code ?? 1
    socket.end(JSON.stringify({
      exitCode,
      stdout,
      stderr,
      ...(signal ? { signal } : {}),
      ...(truncated ? { truncated: true } : {}),
    }) + '\n')
  })
  socket.on('close', () => killChild(child))
  socket.on('error', () => killChild(child))
  return { ok: true }
}

/**
 * `ports` stream: push the pod's localhost-reachable LISTEN ports as JSON
 * lines: once right after the {ok} reply, on every change, and as a periodic
 * keepalive so the server can tell a quiet pod from a dead stream. streamd's
 * own port is always excluded.
 */
function handlePorts(socket, _params, _leftover, ctx) {
  let lastKey = null
  let lastSentAt = 0
  const emit = () => {
    let ports
    try {
      ports = readListeningPorts(ctx.procNetDir)
    } catch {
      ports = []
    }
    ports = ports.filter((p) => p !== ctx.boundPort())
    const key = ports.join(',')
    const now = Date.now()
    if (key === lastKey && now - lastSentAt < ctx.portsKeepaliveMs) return
    lastKey = key
    lastSentAt = now
    socket.write(JSON.stringify({ ports }) + '\n')
  }
  const timer = setInterval(emit, ctx.portsPollMs)
  // Deferred so the {ok} reply, written after this returns, comes first.
  setImmediate(emit)
  socket.on('close', () => clearInterval(timer))
  socket.on('error', () => clearInterval(timer))
  return { ok: true }
}

function handlePty(socket, params, leftover) {
  if (!isArgv(params.cmd)) return { ok: false, error: 'pty: cmd must be a non-empty argv array' }
  const cols = Number.isInteger(params.cols) && params.cols >= 1 && params.cols <= 1000 ? params.cols : 80
  const rows = Number.isInteger(params.rows) && params.rows >= 1 && params.rows <= 1000 ? params.rows : 24
  let ptyProc
  try {
    ptyProc = pty.spawn(params.cmd[0], params.cmd.slice(1), {
      // Must match the image's TERM; lesser entries drop cursor hiding
      // and 256-color output.
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME ?? '/',
      env: process.env,
    })
  } catch (err) {
    return { ok: false, error: `pty: spawn failed: ${err.message}` }
  }

  let killed = false
  const kill = (signal) => {
    if (killed && !signal) return
    try { ptyProc.kill(signal) } catch { /* already gone */ }
    if (!signal) killed = true
  }

  const parser = new FrameParser()
  const onFrames = (chunk) => {
    let frames
    try {
      frames = parser.feed(chunk)
    } catch {
      socket.destroy()
      kill()
      return
    }
    for (const f of frames) {
      if (f.type === FRAME_DATA) {
        ptyProc.write(f.payload.toString('utf8'))
      } else if (f.type === FRAME_RESIZE) {
        try {
          const { cols: c, rows: r } = JSON.parse(f.payload.toString('utf8'))
          if (Number.isInteger(c) && Number.isInteger(r) && c >= 1 && r >= 1 && c <= 1000 && r <= 1000) {
            ptyProc.resize(c, r)
          }
        } catch { /* malformed resize — ignore */ }
      } else if (f.type === FRAME_SIGNAL) {
        try {
          const { name } = JSON.parse(f.payload.toString('utf8'))
          if (typeof name === 'string' && SIGNAL_NAME.test(name)) kill(name)
        } catch { /* malformed signal — ignore */ }
      }
    }
  }
  if (leftover.length > 0) onFrames(leftover)
  socket.on('data', onFrames)

  // Output is batched (see batcher.js). node-pty has no pull API, so pause
  // the pty when the socket backs up and resume on drain.
  const batcher = createOutputBatcher((buf) => {
    const writable = socket.write(encodeFrame(FRAME_DATA, buf))
    if (!writable && typeof ptyProc.pause === 'function') ptyProc.pause()
  })
  ptyProc.onData((data) => batcher.push(Buffer.from(data, 'utf8')))
  socket.on('drain', () => {
    if (typeof ptyProc.resume === 'function') ptyProc.resume()
  })
  ptyProc.onExit(({ exitCode }) => {
    try {
      batcher.flush() // all output precedes the exit frame
      socket.write(encodeFrame(FRAME_EXIT, { code: exitCode }))
    } catch { /* socket gone */ }
    socket.end()
  })
  // A client EOF on a PTY stream is a detach; with allowHalfOpen the
  // socket and child would otherwise stay up forever.
  socket.on('end', () => {
    kill()
    socket.destroy()
  })
  socket.on('close', () => {
    batcher.dispose() // a live flush timer must not write to a dead socket
    kill()
  })
  socket.on('error', () => kill())
  return { ok: true }
}

/** Create the daemon (not yet listening). */
export function createStreamd({
  token,
  port = DEFAULT_STREAM_PORT,
  host = '0.0.0.0',
  procNetDir = '/proc/net',
  portsPollMs = PORTS_POLL_MS,
  portsKeepaliveMs = PORTS_KEEPALIVE_MS,
} = {}) {
  if (!token) throw new Error('streamd: token is required')
  let active = 0
  let boundPort = port
  const ctx = {
    procNetDir,
    portsPollMs,
    portsKeepaliveMs,
    boundPort: () => boundPort,
  }

  // allowHalfOpen: a client EOF must reach the child or target while its
  // output keeps flowing back.
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('error', () => { /* per-stream errors close the stream */ })
    // The batcher already decides when to write; Nagle would only add latency.
    socket.setNoDelay(true)
    let buf = Buffer.alloc(0)
    const timer = setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS)

    const reply = (obj) => socket.write(JSON.stringify(obj) + '\n')
    const refuse = (error) => {
      clearTimeout(timer)
      reply({ ok: false, error })
      socket.end()
    }

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const nl = buf.indexOf(0x0a)
      if (nl < 0) {
        if (buf.length > HANDSHAKE_MAX_BYTES) { clearTimeout(timer); socket.destroy() }
        return
      }
      socket.removeListener('data', onData)
      clearTimeout(timer)

      let params
      try {
        params = JSON.parse(buf.subarray(0, nl).toString('utf8'))
      } catch {
        refuse('malformed handshake')
        return
      }
      if (!params || typeof params !== 'object' || typeof params.token !== 'string') {
        refuse('malformed handshake')
        return
      }
      if (!timingSafeStrEqual(params.token, token)) {
        refuse('bad token')
        return
      }
      if (active >= MAX_STREAMS) {
        refuse('too many streams')
        return
      }

      const leftover = buf.subarray(nl + 1)
      const handlers = { tcp: handleTcp, ctrl: handleCtrl, exec: handleExec, pty: handlePty, ports: handlePorts }
      const handler = handlers[params.kind]
      if (!handler) {
        refuse(`unknown kind ${JSON.stringify(params.kind)}`)
        return
      }
      const result = handler(socket, params, leftover, ctx)
      if (!result.ok) {
        refuse(result.error)
        return
      }
      active++
      socket.once('close', () => { active-- })
      reply({ ok: true })
    }
    socket.on('data', onData)
  })

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.removeListener('error', reject)
          boundPort = server.address().port
          resolve(boundPort)
        })
      })
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
