/**
 * acpd — the in-pod supervisor for one ACP agent process.
 *
 * yaac runs agents under tmux so a closed tab, dropped relay, or restarted
 * server does not kill a turn in progress. An ACP agent speaks JSON-RPC over
 * stdio, which a PTY would corrupt, and a streamd `ctrl` stream kills its
 * child when the socket closes. So acpd runs inside a tmux window, owns the
 * agent's stdio, and exposes it on a UNIX socket the server can attach to and
 * detach from freely:
 *
 *     tmux window                          server
 *     ┌───────────────────────────┐        ┌──────────────────────┐
 *     │ acpd ── stdio ── agent    │        │ ACP client           │
 *     │   └── /tmp/yaac-acp/*.sock│◄───────┤ ctrl stream + socat  │
 *     └───────────────────────────┘        └──────────────────────┘
 *
 * acpd does not interpret JSON-RPC; all protocol logic lives in the server.
 *
 * ## The record
 *
 * Every line relayed in either direction is appended to `--log`, one whole
 * line at a time. The file is the conversation's history, written
 * whether or not a client is attached, on a host-mounted path the server can
 * read even after the pod is gone. The server reads it for live output too,
 * so nothing is buffered for an absent client. Client lines are recorded
 * because the agent echoes user messages only when replaying `session/load`.
 *
 * The record is synced (`fdatasync`) after each client line, after acpd's
 * own lines, and once the agent's output pauses or has run on for a while. On
 * NFS a file's data reaches the server only when it is closed, synced or the
 * kernel writes it back (up to 30 s later), and the server reads the record
 * from another node, so an unsynced record would show a sent message only once
 * the agent's next output pushed it out. It is synced, not closed and
 * reopened, because the server renames a fresh conversation's record from its
 * own node, which neither the old path nor, under gVisor, `/dev/fd/<fd>`
 * follows.
 *
 * Images are kept out of it (see "Images" below), and every other byte is
 * recorded verbatim.
 *
 * A conversation that cannot be recorded cannot be rendered, even though RPC
 * still works. So a record failure restarts the agent under a fresh record,
 * and the reattaching client's `session/load` replays the conversation into
 * it. The file is truncated on each start and its first line holds a new life
 * id, so a replay never duplicates history.
 *
 * ## Images
 *
 * A screenshot is megabytes of base64, and the agent repeats it in more than
 * one field of a tool result, so a few dozen would fill the record past what
 * the server reads. Each long line is parsed, and every `data` string in it
 * that decodes to a PNG, JPEG, GIF or WebP is written to `images/<sha256>`
 * beside the record and replaced by `yaac-image:<sha256>`. The server serves
 * the image from there. The relayed bytes are unchanged; only the record
 * differs. A line that fails to parse, or an image that cannot be stored,
 * is recorded as it came.
 *
 * ## Attach semantics
 *
 * At most one client at a time; a new connection displaces the old, so a
 * stale half-open socket cannot lock the agent out. Two control notifications
 * use the `_acpd/` prefix, which no ACP method uses:
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

/** How long the agent's output must pause before the record is settled, and
 *  the longest a busy record goes unsettled (see "The record"). */
const SETTLE_QUIET_MS = 50
const SETTLE_MAX_MS = 200

/** Lines shorter than this are recorded unparsed: an image worth storing
 *  apart makes its line at least this long. */
const IMAGE_LINE_CHARS = 16 * 1024
/** The shortest base64 string stored as an image (about 6 KB decoded). */
const IMAGE_DATA_CHARS = 8 * 1024
/** What an image's `data` becomes in the record; base64 has no `:`, so it
 *  cannot be mistaken for image data. */
const IMAGE_REF_PREFIX = 'yaac-image:'

function controlLine(method, params) {
  return `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`
}

/** Whether `bytes` start like a PNG, JPEG, GIF or WebP; the server serves
 *  only those (`sniffImage` in @yaac/shared/attachments). */
function isImage(bytes) {
  const ascii = (at, text) => bytes.subarray(at, at + text.length).toString('latin1') === text
  return (bytes[0] === 0x89 && ascii(1, 'PNG'))
    || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || ascii(0, 'GIF8')
    || (ascii(0, 'RIFF') && ascii(8, 'WEBP'))
}

/**
 * Create the daemon (not yet listening). `cwd` is the workspace checkout,
 * which differs per driver; see main.js's `--cwd`.
 */
export function createAcpd({
  sockPath,
  argv,
  logPath,
  env = process.env,
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
   * True once a client has sent something, i.e. the ACP handshake started.
   * A client that connected and died before writing ran no handshake, so its
   * successor must still be told `firstAttach:true`.
   */
  let everSpoke = false
  let child = null
  let client = null
  let childExit = null
  let server = null
  let closing = false

  /** The record's fd. */
  let logFd = null
  /**
   * Record-failure restarts allowed before acpd exits. A full disk does not
   * heal, so exiting beats respawning forever.
   */
  const RECORD_RESTART_LIMIT = 3
  let recordRestarts = 0
  /** Set while we are tearing the agent down on purpose, so its exit is not
   *  read as the agent dying. */
  let restarting = false
  /** The pending settle, and when the oldest unsettled bytes were written. */
  let settleTimer = null
  let unsettledSince = 0

  /**
   * Open (or reopen) the record with a fresh life id, which tells the
   * server's tailer to discard what it read from the previous file.
   */
  function openRecord() {
    if (!logPath) return true
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      logFd = fs.openSync(logPath, 'w')
      fs.writeSync(logFd, `${JSON.stringify({
        jsonrpc: '2.0',
        method: '_acpd/life',
        params: { id: crypto.randomUUID(), startedAt: new Date().toISOString() },
      })}\n`)
      fs.fdatasyncSync(logFd)
      return true
    } catch (err) {
      log(`log unavailable (${err.message})`)
      logFd = null
      return false
    }
  }

  /**
   * Restart the agent under a fresh record after a record write failed (see
   * the header). The client is dropped so it reattaches, sees
   * `firstAttach:true`, and re-runs the handshake against the new process.
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

    everSpoke = false
    client?.destroy()
    client = null

    const previous = child
    const hard = terminate(previous)
    previous.once('exit', () => {
      clearTimeout(hard)
      if (closing) return
      restarting = false
      if (!openRecord()) {
        log('the record could not be reopened; exiting rather than running blind')
        shutdown(1, null)
        return
      }
      childExit = null
      startChild()
    })
  }

  /** SIGTERM `proc`, then SIGKILL it if it outlives the grace period.
   *  Returns the SIGKILL timer so a caller that sees the exit can clear it. */
  function terminate(proc) {
    proc.kill('SIGTERM')
    const hard = setTimeout(() => proc.kill('SIGKILL'), killGraceMs)
    hard.unref()
    return hard
  }

  /** Drop the record's fd after a failure and restart the agent under a
   *  fresh one. */
  function recordFailed(err) {
    clearTimeout(settleTimer)
    settleTimer = null
    if (logFd !== null) {
      try {
        fs.closeSync(logFd)
      } catch { /* already gone */ }
      logFd = null
    }
    restartForRecord(err.message)
  }

  /** Sync the record so what was written reaches the reader. */
  function settle() {
    clearTimeout(settleTimer)
    settleTimer = null
    if (logFd === null) return
    try {
      fs.fdatasyncSync(logFd)
    } catch (err) {
      recordFailed(err)
    }
  }

  /** Settle once the output pauses, or by SETTLE_MAX_MS after the oldest
   *  unsettled write if it never does. */
  function settleSoon() {
    const now = Date.now()
    if (settleTimer === null) unsettledSince = now
    clearTimeout(settleTimer)
    settleTimer = setTimeout(settle, Math.max(0, Math.min(SETTLE_QUIET_MS, unsettledSince + SETTLE_MAX_MS - now)))
    settleTimer.unref()
  }

  /**
   * Store one base64 image under its hash, written whole and durably named
   * (the dir synced after the rename) before the record names it, so not
   * even a power loss leaves the record pointing at a missing file.
   * Undefined if the data is not an image.
   */
  function storeImage(b64) {
    if (!isImage(Buffer.from(b64.slice(0, 16), 'base64'))) return undefined
    const bytes = Buffer.from(b64, 'base64')
    const hash = crypto.createHash('sha256').update(bytes).digest('hex')
    const dir = path.join(path.dirname(logPath), 'images')
    const file = path.join(dir, hash)
    if (fs.existsSync(file)) return hash
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    try {
      const fd = fs.openSync(tmp, 'w')
      try {
        fs.writeSync(fd, bytes)
        fs.fdatasyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, file)
    } catch (err) {
      fs.rmSync(tmp, { force: true })
      throw err
    }
    const dirFd = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(dirFd)
    } finally {
      fs.closeSync(dirFd)
    }
    return hash
  }

  /** Replace every image `data` under `value` with a stored image's ref;
   *  returns whether any was. */
  function storeImagesIn(value) {
    if (typeof value !== 'object' || value === null) return false
    let stored = false
    for (const [key, v] of Object.entries(value)) {
      if (key === 'data' && typeof v === 'string' && v.length >= IMAGE_DATA_CHARS) {
        const hash = storeImage(v)
        if (hash === undefined) continue
        value[key] = `${IMAGE_REF_PREFIX}${hash}`
        stored = true
      } else if (storeImagesIn(v)) {
        stored = true
      }
    }
    return stored
  }

  /** Whole lines as the record keeps them: images stored apart (see
   *  "Images" in the header). */
  function withoutImages(buf) {
    if (buf.length < IMAGE_LINE_CHARS) return buf
    let changed = false
    const lines = buf.toString('utf8').split('\n').map((line) => {
      if (line.length < IMAGE_LINE_CHARS) return line
      try {
        const msg = JSON.parse(line)
        if (!storeImagesIn(msg)) return line
        changed = true
        return JSON.stringify(msg)
      } catch (err) {
        if (!(err instanceof SyntaxError)) log(`image not stored apart (${err.message})`)
        return line
      }
    })
    return changed ? Buffer.from(lines.join('\n'), 'utf8') : buf
  }

  /**
   * Append relayed bytes to the record; a failure restarts the agent. `now`
   * settles at once, for lines a reader is waiting on; the agent's output
   * settles once it pauses.
   */
  function record(buf, now) {
    if (logFd === null) return
    try {
      fs.writeSync(logFd, withoutImages(buf))
    } catch (err) {
      recordFailed(err)
      return
    }
    if (now) settle()
    else settleSoon()
  }

  /**
   * A `record` for one direction that writes only whole lines, so a long line
   * arriving in chunks (e.g. a prompt with a base64 image) is never
   * interleaved with the other direction. `abandon` drops an unfinished tail
   * and returns whether there was one. `now` is passed on to `record`.
   */
  function lineRecorder(now) {
    let pending = []
    const recorder = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
      const end = buf.lastIndexOf(0x0a) + 1
      if (end === 0) {
        pending.push(buf)
        return
      }
      record(Buffer.concat([...pending, buf.subarray(0, end)]), now)
      pending = end < buf.length ? [buf.subarray(end)] : []
    }
    recorder.abandon = () => {
      const had = pending.length > 0
      pending = []
      return had
    }
    return recorder
  }

  /** Spawn the agent and wire its stdio. Runs again on each restart. */
  function startChild() {
    child = spawn(argv[0], argv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd,
    })

    // Diagnostics go to the tmux pane, where a human attaching would look.
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

    // An unhandled EPIPE here would crash acpd before it could send
    // `_acpd/exit`. The exit handler does the teardown.
    child.stdin.on('error', (err) => {
      log(`agent stdin: ${err.message}`)
    })

    child.on('exit', (code, signal) => {
      if (restarting) return
      childExit = { code: code ?? 0, signal: signal ?? null }
      log(`agent exited (code=${childExit.code} signal=${childExit.signal})`)
      const exit = controlLine('_acpd/exit', childExit)
      // Recorded too, since a notice sent while detached is otherwise lost.
      record(exit, true)
      emit(exit)
      // Give the line a tick to reach an attached client before tearing down.
      setTimeout(() => shutdown(childExit.code, childExit.signal), 50).unref()
    })

    const recordStdout = lineRecorder(false)
    child.stdout.on('data', (chunk) => {
      recordStdout(chunk)
      emit(chunk)
    })
  }

  /**
   * Forward to the attached client, if any; nothing is buffered otherwise.
   * Socket backpressure pauses the agent's stdout.
   */
  function emit(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    if (!client || client.destroyed || !client.writable) return
    if (!client.write(buf)) child.stdout.pause()
  }

  // A record that cannot be opened at all is fatal (see `listen`).
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
      log('displacing previous client')
      const previous = client
      client = null
      previous.destroy()
    }
    client = sock
    sock.write(controlLine('_acpd/hello', { firstAttach: !everSpoke }))
    child.stdout.resume()

    const recordClient = lineRecorder(true)
    sock.on('data', (chunk) => {
      everSpoke = true
      recordClient(chunk)
      if (!child.stdin.destroyed) child.stdin.write(chunk)
    })
    sock.on('drain', () => child.stdout.resume())
    // A client that leaves mid-line has sent the agent a fragment. Ending it
    // with a newline stops the next client's first line being glued onto it.
    const endLine = () => {
      if (recordClient.abandon() && !child.stdin.destroyed) child.stdin.write('\n')
    }
    sock.on('error', () => { endLine(); detach(sock, 'error') })
    sock.on('close', () => { endLine(); detach(sock, 'closed') })
    // A client half-close must not end the agent's stdin.
    sock.on('end', () => { /* keep the agent running */ })
  }

  function shutdown(code, signal) {
    if (closing) return
    closing = true
    client?.destroy()
    server?.close()
    try {
      fs.unlinkSync(sockPath)
    } catch {
      /* already gone */
    }
    clearTimeout(settleTimer)
    settleTimer = null
    if (logFd !== null) {
      try {
        fs.closeSync(logFd)
      } catch { /* already gone */ }
      logFd = null
    }
    if (child && childExit === null) terminate(child)
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
        // A stale socket file would make bind() fail with EADDRINUSE.
        try {
          fs.unlinkSync(sockPath)
        } catch {
          /* nothing there */
        }
        server = net.createServer({ allowHalfOpen: true }, (sock) => {
          sock.on('error', () => { /* per-client; attach() reaps it */ })
          // During a restart, refuse: an accepted `initialize` would reach
          // the dying child and set `everSpoke` for a handshake the new agent
          // never saw. The server retries with backoff.
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
          // Same-uid access only.
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
