/**
 * acpd — the in-pod supervisor for one ACP agent process.
 *
 * yaac runs coding agents under tmux because tmux outlives the viewer: a
 * closed browser tab, a dropped relay, or a restarted server must not kill a
 * turn in progress. An ACP agent is a JSON-RPC-over-stdio process, so tmux
 * alone cannot serve it — a PTY would corrupt the protocol, and a plain
 * streamd `ctrl` stream owns its child (socket close ⇒ SIGTERM), which puts
 * the agent's life back on the connection.
 *
 * acpd is the missing half. It runs *inside* a tmux window (so tmux still
 * supervises it, still lists it, still reaps it with the session), owns the
 * agent's stdio, and exposes it on a UNIX socket the server attaches to and
 * detaches from freely:
 *
 *     tmux window                          server
 *     ┌───────────────────────────┐        ┌──────────────────────┐
 *     │ acpd ── stdio ── agent    │        │ ACP client           │
 *     │   └── /tmp/yaac-acp/*.sock│◄───────┤ ctrl stream + socat  │
 *     └───────────────────────────┘        └──────────────────────┘
 *
 * It is deliberately a *dumb pipe*: it does not parse JSON-RPC, and no ACP
 * knowledge lives here. Everything the protocol means is the server's
 * business, the same division streamd draws.
 *
 * ## The record
 *
 * Every byte acpd relays, in both directions, is appended verbatim to `--log`.
 * That file IS the conversation's history: written whether or not a client is
 * attached, on a host-mounted path the server reads without going through the
 * pod — and can still read once the pod is gone.
 *
 * That is why nothing is buffered for an absent client: the record is not
 * merely where history comes from, it is the only path by which content
 * reaches a pane at all — the server reads it for live output too. A socket
 * carries the RPC half and nothing more. Both directions are recorded because
 * the agent echoes a user message only when replaying under `session/load`, so
 * without the client's own `session/prompt` lines the record would show no
 * user turns for anything said live.
 *
 * Which makes the record load-bearing: a conversation that cannot be recorded
 * cannot be rendered, however healthy it looks from here — RPC still works and
 * turns still complete, so the failure is invisible from every side except the
 * one that matters. So a record that fails is not survived, it is *restarted*:
 * the agent comes back under a fresh record and the reattaching client's
 * `session/load` replays the whole conversation into it. Nothing is lost, and
 * the alternative is an agent answering into a view that never changes again.
 *
 * The file is truncated when acpd starts and its first line records a life id.
 * A restart's `session/load` replays the whole conversation, so the fresh file
 * ends up complete again rather than double-appending history it already had.
 *
 * `--append` is for the adapter that does not replay: opencode's
 * `session/load` returns the session's models and modes and re-emits nothing,
 * so truncating would leave a reconnected conversation blank. There the record
 * is the only copy of the history and a new life adds to it, its life line
 * landing mid-file rather than at byte 0.
 *
 * ## Attach semantics
 *
 * At most one client at a time; a new connection displaces the old (a stale
 * half-open socket must never lock the agent out). Two control notifications
 * go into the stream, under the `_acpd/` prefix no ACP method can collide with:
 *
 *  - `_acpd/hello  {firstAttach}` — first line of every attach. `firstAttach`
 *    is false when some earlier client already spoke to this agent, which
 *    tells the server the ACP handshake (`initialize`, `session/new`) has
 *    already happened and must not be repeated on a live process.
 *  - `_acpd/exit   {code, signal}` — the agent process is gone, so an attached
 *    server can tell that from a dropped connection without probing. Also
 *    recorded, since a notice sent while detached simply goes nowhere.
 */

import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

/** Grace between SIGTERM and SIGKILL when acpd is shutting the agent down. */
const CHILD_KILL_GRACE_MS = 5_000

function controlLine(method, params) {
  return `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`
}

/**
 * Create the daemon (not yet listening). Injectable options keep it
 * unit-testable in-process: tests pass their own socket path and a trivial
 * child command.
 */
export function createAcpd({
  sockPath,
  argv,
  logPath,
  // Keep what the record already holds rather than starting it over. For an
  // adapter whose `session/load` replays nothing (see the header), the file is
  // the conversation's only history.
  append = false,
  env = process.env,
  // The directory tmux opened this window in, which every driver pins to the
  // workspace (`new-session -c`). A literal path here would be one runtime's
  // answer to "where is the checkout" baked into code both share: under the
  // pod driver `/workspace` is right, and on a host it does not exist — where
  // spawn fails with ENOENT for the *cwd*, reads as a missing binary, and
  // takes the window (and the worktree) down with it. Callers pass the
  // driver's own answer; see main.js's `--cwd`.
  cwd = process.cwd(),
  logStream = process.stderr,
  killGraceMs = CHILD_KILL_GRACE_MS,
}) {
  if (!sockPath) throw new Error('acpd: sockPath is required')
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('acpd: argv is required')

  const log = (msg) => {
    try {
      logStream.write(`[acpd] ${msg}\n`)
    } catch {
      /* the pane went away */
    }
  }

  /**
   * True once a client has SENT something — i.e. the ACP handshake really
   * started. Deliberately not "a socket connected": an adapter's cold start
   * takes seconds, and a client that attached and died before writing has run
   * no handshake at all. Reporting `firstAttach:false` to its successor would
   * tell that successor to skip `initialize` and address a session that was
   * never created, which no later attach could repair.
   */
  let everSpoke = false
  let child = null
  let client = null
  let childExit = null
  let server = null
  let closing = false

  /**
   * Append-only record of everything relayed. Opened with 'w' so a new life
   * starts a new file — or 'a' under `--append`, where the history the file
   * holds is the only copy there is (see the header comment). Written with no
   * encoding translation: the bytes on the wire are the bytes on disk, so the
   * server parses one format rather than two.
   */
  let logFd = null
  /**
   * How many times a record failure may restart the agent before acpd gives
   * up and exits. A full disk does not heal, and each restart costs an adapter
   * cold start, so this is a small number: past it, dying loudly is better
   * than respawning forever.
   */
  const RECORD_RESTART_LIMIT = 3
  let recordRestarts = 0
  /** Set while we are tearing the agent down on purpose, so its exit is not
   *  read as the agent dying. */
  let restarting = false

  /**
   * Open (or reopen) the record, stamping the life id that identifies it. A
   * fresh id is what tells the server's tailer that everything it had belongs
   * to a previous life and must be replaced.
   */
  function openRecord() {
    if (!logPath) return true
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      logFd = fs.openSync(logPath, append ? 'a' : 'w')
      fs.writeSync(logFd, `${JSON.stringify({
        jsonrpc: '2.0',
        method: '_acpd/life',
        params: { id: crypto.randomUUID(), startedAt: new Date().toISOString() },
      })}\n`)
      return true
    } catch (err) {
      log(`log unavailable (${err.message})`)
      logFd = null
      return false
    }
  }

  /**
   * The record failed, so this conversation can no longer be *rendered* —
   * content reaches a pane through the record alone. RPC still works and turns
   * still complete, which is precisely the danger: without this the agent
   * would keep answering into a view that never changes again, with the only
   * evidence a line in a tmux pane nobody in ACP mode looks at.
   *
   * So the agent is restarted under a fresh record rather than left running
   * blind. Nothing is lost by that: the client reattaches, sees
   * `firstAttach:true`, and its `session/load` replays the whole conversation
   * into the new file. Dropping the client is what makes it happen — a client
   * that stayed attached would go on talking to a process that never received
   * `initialize`.
   */
  function restartForRecord(reason) {
    if (closing || restarting) return
    if (recordRestarts >= RECORD_RESTART_LIMIT) {
      log(`record failed again (${reason}) after ${recordRestarts} restarts; giving up`)
      shutdown(1, null)
      return
    }
    recordRestarts += 1
    restarting = true
    log(`record failed (${reason}); restarting the agent under a fresh record `
      + `(${recordRestarts}/${RECORD_RESTART_LIMIT})`)

    // The next attach must run the handshake again: it is a new agent process,
    // and it has been told nothing.
    everSpoke = false
    client?.destroy()
    client = null

    const previous = child
    const hard = setTimeout(() => {
      try {
        previous.kill('SIGKILL')
      } catch { /* already gone */ }
    }, killGraceMs)
    hard.unref()

    previous.once('exit', () => {
      clearTimeout(hard)
      if (closing) return
      restarting = false
      if (!openRecord()) {
        // The disk has not healed. Spawning another agent only to be blind
        // again is worse than dying: the window closes, which is at least a
        // state the server and a human can both see.
        log('the record could not be reopened; exiting rather than running blind')
        shutdown(1, null)
        return
      }
      childExit = null
      startChild()
    })
    previous.kill('SIGTERM')
  }

  /** Append relayed bytes to the record. A failure here is not survivable —
   *  see `restartForRecord`. */
  function record(buf) {
    if (logFd === null) return
    try {
      fs.writeSync(logFd, buf)
    } catch (err) {
      try {
        fs.closeSync(logFd)
      } catch { /* already gone */ }
      logFd = null
      restartForRecord(err.message)
    }
  }

  /**
   * Spawn the agent and wire its stdio. Factored out because a record failure
   * restarts it (see `restartForRecord`) — everything below is per agent
   * process, not per acpd process.
   */
  function startChild() {
    child = spawn(argv[0], argv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd,
    })

    // The agent's stderr is diagnostics, never protocol. It goes to acpd's own
    // stderr, which is the tmux pane — so a human who attaches to the window
    // sees an adapter's startup failure exactly where they'd look for it.
    child.stderr.on('data', (chunk) => {
      try {
        logStream.write(chunk)
      } catch {
        /* ignore */
      }
    })

    child.on('error', (err) => {
      log(`agent spawn failed: ${err.message}`)
      shutdown(127, null)
    })

    // An agent that exits while a client is mid-write leaves an in-flight write
    // to a closed pipe, and an unhandled EPIPE on stdin would take acpd down
    // with it — losing the `_acpd/exit` notice that tells the server what
    // happened. The exit handler below owns the teardown; this only stops the
    // crash.
    child.stdin.on('error', (err) => {
      log(`agent stdin: ${err.message}`)
    })

    child.on('exit', (code, signal) => {
      // A restart kills the agent on purpose and spawns the next one itself.
      if (restarting) return
      childExit = { code: code ?? 0, signal: signal ?? null }
      log(`agent exited (code=${childExit.code} signal=${childExit.signal})`)
      const exit = controlLine('_acpd/exit', childExit)
      // Into the record as well as the socket: with nothing buffered, a notice
      // sent while detached is simply gone, and the record is where a reader
      // can still see that this conversation ended rather than paused.
      record(exit)
      emit(exit)
      // Give the line a tick to reach an attached client before tearing down.
      setTimeout(() => shutdown(childExit.code, childExit.signal), 50).unref()
    })

    child.stdout.on('data', (chunk) => {
      // Recorded before delivery, and regardless of whether anyone is attached:
      // that is what makes the file complete rather than a view of one client's
      // connection.
      record(chunk)
      emit(chunk)
    })
  }

  /**
   * Forward to the attached client, if there is one. Nothing is held for a
   * client that is not: the record already has it, and the next attach reads
   * the record. Backpressure still pauses the agent rather than growing the
   * socket's buffer, so the LIVE stream stays complete for as long as someone
   * is watching it.
   */
  function emit(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    if (!client || client.destroyed || !client.writable) return
    if (!client.write(buf)) child.stdout.pause()
  }

  // A record that cannot be opened at all is fatal: restarting the agent
  // would not fix a disk, and a conversation nobody can see is worse than a
  // window that visibly died.
  const recordReady = openRecord()
  if (recordReady) startChild()

  function detach(sock, reason) {
    if (client !== sock) return
    client = null
    log(`client detached (${reason})`)
    child.stdout.resume()
  }

  function attach(sock) {
    if (client) {
      // A displaced client is almost always a half-open socket the relay has
      // not reaped yet. The newest attach wins — the alternative is an agent
      // no one can reach until a TCP timeout fires.
      log('displacing previous client')
      const previous = client
      client = null
      previous.destroy()
    }
    client = sock
    // Recomputed per attach, so a socket dying before it lands costs nothing.
    sock.write(controlLine('_acpd/hello', { firstAttach: !everSpoke }))
    child.stdout.resume()

    sock.on('data', (chunk) => {
      everSpoke = true
      // Recorded too: the agent echoes a user message only when replaying under
      // `session/load`, so without the client's own `session/prompt` lines the
      // record would show no user turns for anything said live.
      record(chunk)
      if (!child.stdin.destroyed) child.stdin.write(chunk)
    })
    sock.on('drain', () => child.stdout.resume())
    sock.on('error', () => detach(sock, 'error'))
    sock.on('close', () => detach(sock, 'closed'))
    // A client half-closing means "I am done sending", not "kill the agent" —
    // the whole point of acpd. Explicitly do NOT end the child's stdin.
    sock.on('end', () => { /* keep the agent running */ })
  }

  function shutdown(code, signal) {
    if (closing) return
    closing = true
    try {
      client?.destroy()
    } catch {
      /* ignore */
    }
    try {
      server?.close()
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(sockPath)
    } catch {
      /* already gone */
    }
    if (logFd !== null) {
      try {
        fs.closeSync(logFd)
      } catch { /* already gone */ }
      logFd = null
    }
    if (childExit === null) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      const hard = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, killGraceMs)
      hard.unref()
    }
    onExit?.(code, signal)
  }

  let onExit = null

  return {
    get child() {
      return child
    },
    /** Called with (code, signal) when the daemon is done; the entrypoint
     *  turns it into a process exit. */
    onExit(fn) {
      onExit = fn
    },
    /** Break the record the way a full disk does, so the restart path can be
     *  driven without one. Test-only. */
    closeRecordForTest() {
      if (logFd === null) return
      fs.closeSync(logFd)
    },
    listen() {
      if (!recordReady) {
        log('no record; refusing to serve a conversation that cannot be rendered')
        setTimeout(() => shutdown(1, null), 0).unref()
      }
      return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 })
        // A socket file left by a previous life of this window would make
        // bind() fail with EADDRINUSE even though nothing is listening.
        try {
          fs.unlinkSync(sockPath)
        } catch {
          /* nothing there */
        }
        server = net.createServer({ allowHalfOpen: true }, (sock) => {
          sock.on('error', () => { /* per-client; attach() reaps it */ })
          // Between an agent's death and its successor's spawn there is
          // nothing to talk to, and accepting anyway is worse than refusing:
          // the client's `initialize` would go into the dying child's stdin
          // and be lost, while `everSpoke` flipped for a handshake the NEW
          // agent never saw — after which every later attach is told
          // `firstAttach:false` and skips `initialize` against a process that
          // was never initialized. The server's reconnect-with-backoff turns a
          // refused dial into a retry that lands on the new child.
          if (restarting || child === null) {
            log('refusing an attach: no agent to serve it')
            sock.destroy()
            return
          }
          attach(sock)
        })
        server.once('error', reject)
        server.listen(sockPath, () => {
          server.removeListener('error', reject)
          // The socket is the agent's control channel — same-uid only.
          try {
            fs.chmodSync(sockPath, 0o600)
          } catch {
            /* best effort */
          }
          log(`listening on ${sockPath} (agent: ${argv.join(' ')})`)
          resolve(sockPath)
        })
      })
    },
    close() {
      shutdown(0, null)
    },
  }
}
