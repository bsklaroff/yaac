import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAcpd } from '../acpd.js'

/**
 * acpd exists for one property: the agent survives its client. Nothing is
 * buffered for an absent one — the record is what a client missed — so these
 * drive a real child over a real socket and check both halves: what reaches an
 * attached client, and what lands in the record regardless.
 *
 * The child is `cat` (a stdin→stdout pipe) rather than a real ACP adapter:
 * acpd parses nothing, so a byte echo exercises everything it actually does.
 */

const daemons: Array<{ close(): void }> = []
const tmpDirs: string[] = []

afterEach(() => {
  for (const d of daemons.splice(0)) d.close()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function sockPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-test-'))
  tmpDirs.push(dir)
  return path.join(dir, 'agent.sock')
}

/** Poll until a condition holds, so a restart's several async steps do not
 *  turn into a guessed sleep. */
async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** A quiet log sink so test output stays readable. */
const quiet = { write: (): boolean => true } as unknown as NodeJS.WriteStream

async function start(argv: string[], opts: Record<string, unknown> = {}): Promise<{
  sock: string
  daemon: ReturnType<typeof createAcpd>
}> {
  const sock = sockPath()
  const daemon = createAcpd({ sockPath: sock, argv, cwd: process.cwd(), logStream: quiet, ...opts })
  daemons.push(daemon)
  await daemon.listen()
  return { sock, daemon }
}

/** Connect and collect every line the daemon sends. */
function connect(sock: string): {
  socket: net.Socket
  lines: string[]
  waitFor: (predicate: (lines: string[]) => boolean, ms?: number) => Promise<void>
} {
  const socket = net.connect(sock)
  const lines: string[] = []
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      lines.push(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
    }
  })
  const waitFor = async (predicate: (l: string[]) => boolean, ms = 5000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!predicate(lines)) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting; saw ${JSON.stringify(lines)}`)
      }
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return { socket, lines, waitFor }
}

const parsed = (lines: string[]): Array<Record<string, unknown>> =>
  lines.map((l) => JSON.parse(l) as Record<string, unknown>)

describe('createAcpd', () => {
  it('announces firstAttach true only to the first client, so a reattach skips the handshake', async () => {
    const { sock } = await start(['cat'])

    const a = connect(sock)
    await a.waitFor((l) => l.length >= 1)
    expect(parsed(a.lines)[0]).toEqual({
      jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: true },
    })

    // Speaking is what makes the handshake real — see the test below.
    a.socket.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')
    await a.waitFor((l) => l.length >= 2)
    a.socket.destroy()
    const b = connect(sock)
    await b.waitFor((l) => l.length >= 1)
    // The agent process is the same one — re-running `initialize` against it
    // would be undefined, which is exactly what this flag prevents.
    expect(parsed(b.lines)[0]).toEqual({
      jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false },
    })
  })

  it('still reports firstAttach when the previous client died before speaking', async () => {
    // An adapter's cold start takes seconds, so a client can attach and be
    // gone before it writes anything. Nothing handshook, so its successor must
    // still run one — telling it otherwise sends it to address a worktree that
    // was never created, and no later attach could ever repair that.
    const { sock } = await start(['cat'])

    const a = connect(sock)
    await a.waitFor((l) => l.length >= 1)
    a.socket.destroy()
    await new Promise((r) => setTimeout(r, 50))

    const b = connect(sock)
    await b.waitFor((l) => l.length >= 1)
    expect(parsed(b.lines)[0]).toEqual({
      jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: true },
    })
  })

  it('records everything it relays, in both directions, attached or not', async () => {
    // The record is the conversation's history, so it must be complete whether
    // or not anyone was watching — that is what lets the buffer not exist.
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-log-')), 'c.jsonl')
    tmpDirs.push(path.dirname(logPath))
    const { sock, daemon } = await start(['cat'], { logPath })

    const a = connect(sock)
    await a.waitFor((l) => l.length >= 1)
    a.socket.write('{"said":"while attached"}\n')
    await a.waitFor((l) => l.some((line) => line.includes('while attached')))
    a.socket.destroy()
    await new Promise((r) => setTimeout(r, 50))

    // Produced with nobody listening: dropped from the socket, kept in the record.
    daemon.child.stdin.write('{"said":"while detached"}\n')
    await new Promise((r) => setTimeout(r, 100))

    const recorded = fs.readFileSync(logPath, 'utf8')
    // The life header, then both directions in arrival order.
    expect(recorded.split('\n')[0]).toContain('_acpd/life')
    expect(recorded).toContain('while attached')
    expect(recorded).toContain('while detached')
  })

  it('starts the record over by default, and keeps it under --append', async () => {
    // Truncating is right for an adapter that replays: its `session/load`
    // re-emits the whole conversation into the fresh file, so the record ends
    // up complete rather than holding two copies. It is wrong for one that
    // does not — opencode's load returns models and modes and re-emits
    // nothing — where the file IS the only history and a new life must add to
    // it, its life line landing mid-file rather than at byte 0.
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-log-')), 'c.jsonl')
    tmpDirs.push(path.dirname(logPath))
    fs.writeFileSync(logPath, '{"from":"an earlier life"}\n')

    const fresh = await start(['cat'], { logPath })
    await waitUntil(() => fs.readFileSync(logPath, 'utf8').includes('_acpd/life'))
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain('an earlier life')
    fresh.daemon.close()

    fs.writeFileSync(logPath, '{"from":"an earlier life"}\n')
    await start(['cat'], { logPath, append: true })
    await waitUntil(() => fs.readFileSync(logPath, 'utf8').includes('_acpd/life'))
    const kept = fs.readFileSync(logPath, 'utf8').split('\n')
    expect(kept[0]).toContain('an earlier life')
    expect(kept[1]).toContain('_acpd/life')
  })

  it('starts the appended life on its own line even after a torn write', async () => {
    // A life that was killed mid-write leaves a partial line. Appending the
    // header onto it makes ONE unparseable line, and a reader that drops it
    // never sees the boundary — so the dead life's unanswered prompt or
    // permission ask is inherited by this one, which then shows as working, or
    // waiting on a person, for a turn no process is running.
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-log-')), 'c.jsonl')
    tmpDirs.push(path.dirname(logPath))
    fs.writeFileSync(logPath, '{"id":7,"method":"session/prom')

    await start(['cat'], { logPath, append: true })
    await waitUntil(() => fs.readFileSync(logPath, 'utf8').includes('_acpd/life'))
    const lines = fs.readFileSync(logPath, 'utf8').split('\n')
    // The torn line is left as it is — nothing can repair it — but the header
    // is a line of its own, which is all a reader needs.
    expect(lines[0]).toBe('{"id":7,"method":"session/prom')
    expect(JSON.parse(lines[1]).method).toBe('_acpd/life')
  })

  it('does not replay to a new client — the record is what it missed', async () => {
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-log-')), 'c.jsonl')
    tmpDirs.push(path.dirname(logPath))
    const { sock, daemon } = await start(['cat'], { logPath })

    const a = connect(sock)
    await a.waitFor((l) => l.length >= 1)
    a.socket.destroy()
    await new Promise((r) => setTimeout(r, 50))
    daemon.child.stdin.write('{"missed":true}\n')
    await new Promise((r) => setTimeout(r, 100))

    const b = connect(sock)
    await b.waitFor((l) => l.length >= 1)
    await new Promise((r) => setTimeout(r, 100))
    // Only the greeting: the server reads the record for anything older.
    expect(b.lines.filter((l) => l.includes('"missed"'))).toEqual([])
    expect(fs.readFileSync(logPath, 'utf8')).toContain('"missed"')
  })

  it('records the agent\'s exit, which a detached client would never see', async () => {
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-log-')), 'c.jsonl')
    tmpDirs.push(path.dirname(logPath))
    await start(['sh', '-c', 'exit 4'], { logPath })
    await new Promise((r) => setTimeout(r, 300))

    // A reader of a stopped conversation can still tell it ended rather than
    // paused.
    expect(fs.readFileSync(logPath, 'utf8')).toContain('_acpd/exit')
  })

  it('restarts the agent under a fresh record when the record fails', async () => {
    // Content reaches a pane through the record alone, so an agent that keeps
    // running with a broken record is answering into a view that will never
    // change again. Restarting is what makes that recoverable: the client
    // reattaches, is told firstAttach, and its worktree/load refills the file.
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-log-')), 'c.jsonl')
    tmpDirs.push(path.dirname(logPath))
    const { sock, daemon } = await start(['cat'], { logPath })

    const a = connect(sock)
    await a.waitFor((l) => l.some((line) => line.includes('_acpd/hello')))
    const firstLife = fs.readFileSync(logPath, 'utf8').split('\n')[0]
    const firstChild = daemon.child

    // Break the record the way a full disk does: the descriptor stops taking
    // writes. Closing it out from under acpd makes the next write throw EBADF.
    daemon.closeRecordForTest()
    daemon.child.stdin.write('{"triggers":"the write"}\n')

    // The client is dropped, because a client that stayed attached would go on
    // talking to a process that never received `initialize`.
    await waitUntil(() => a.socket.destroyed)
    await waitUntil(() => daemon.child !== firstChild)

    // A fresh life, so the server's tailer replaces rather than appends.
    const b = connect(sock)
    await b.waitFor((l) => l.some((line) => line.includes('_acpd/hello')))
    expect(b.lines.some((l) => l.includes('"firstAttach":true'))).toBe(true)
    const secondLife = fs.readFileSync(logPath, 'utf8').split('\n')[0]
    expect(secondLife).toContain('_acpd/life')
    expect(secondLife).not.toBe(firstLife)

    // And the new agent is really relaying.
    b.socket.write('{"after":"restart"}\n')
    await b.waitFor((l) => l.some((line) => line.includes('"after"')))
  })

  it('refuses an attach while the agent is being restarted', async () => {
    // The dangerous window: the old agent is dying, the new one is not yet
    // spawned. Accepting here would write the client's `initialize` into the
    // dying child's stdin and flip `everSpoke` for a handshake the new agent
    // never saw — after which every later attach is told firstAttach:false and
    // skips `initialize` against a process that was never initialized.
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-log-')), 'c.jsonl')
    tmpDirs.push(path.dirname(logPath))
    // An agent that ignores SIGTERM holds the window open for the whole grace,
    // which is what makes this drivable rather than a race.
    const { sock, daemon } = await start(
      ['sh', '-c', 'trap "" TERM; cat'],
      { logPath, killGraceMs: 300 },
    )

    const a = connect(sock)
    await a.waitFor((l) => l.some((line) => line.includes('_acpd/hello')))
    const firstChild = daemon.child

    daemon.closeRecordForTest()
    daemon.child.stdin.write('{"triggers":"the write"}\n')
    await waitUntil(() => a.socket.destroyed)

    // Mid-restart: the server's redial (1s once detached) lands right here.
    const during = connect(sock)
    await waitUntil(() => during.socket.destroyed)
    expect(during.lines).toEqual([])

    // Once the new agent is up, an attach is served again — and truthfully.
    await waitUntil(() => daemon.child !== firstChild, 5000)
    const after = connect(sock)
    await after.waitFor((l) => l.some((line) => line.includes('_acpd/hello')))
    expect(after.lines.some((l) => l.includes('"firstAttach":true'))).toBe(true)
  })

  it('gives up rather than restarting forever when the record cannot be repaired', async () => {
    // A full disk does not heal, and every restart costs an adapter cold
    // start. Past the limit acpd dies loudly instead of spinning.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-log-'))
    tmpDirs.push(dir)
    // A directory where the record should be: every open fails, forever.
    const logPath = path.join(dir, 'c.jsonl')
    fs.mkdirSync(logPath)
    const sock = sockPath()
    const daemon = createAcpd({
      sockPath: sock, argv: ['cat'], cwd: process.cwd(), logStream: quiet, logPath,
    })
    daemons.push(daemon)
    const exited = new Promise<number>((resolve) => daemon.onExit((code) => resolve(code)))
    await daemon.listen()

    // No agent is even spawned: a conversation nobody can see is worse than a
    // window that visibly died, and restarting would not fix a disk.
    expect(daemon.child).toBe(null)
    expect(await Promise.race([
      exited,
      new Promise((r) => setTimeout(() => r('still running'), 2000)),
    ])).toBe(1)
  })

  it('relays without a record when none was asked for', async () => {
    const { sock } = await start(['cat'])
    const a = connect(sock)
    await a.waitFor((l) => l.length >= 1)
    a.socket.write('{"still":"works"}\n')
    await a.waitFor((l) => l.some((line) => line.includes('works')))
  })

  it('displaces a stale client so a half-open socket cannot lock the agent out', async () => {
    const { sock } = await start(['cat'])

    const a = connect(sock)
    await a.waitFor((l) => l.length >= 1)
    const b = connect(sock)
    await b.waitFor((l) => l.length >= 1)

    // The newest attach wins; the displaced one is closed.
    await new Promise((r) => setTimeout(r, 50))
    expect(a.socket.destroyed).toBe(true)

    b.socket.write('{"mine":1}\n')
    await b.waitFor((l) => l.some((line) => line.includes('"mine"')))
  })

  it('reports the agent exiting so the server never waits on a dead process', async () => {
    const { sock } = await start(['sh', '-c', 'exit 3'])

    const a = connect(sock)
    await a.waitFor((l) => l.some((line) => line.includes('_acpd/exit')))
    const exit = parsed(a.lines).find((m) => m.method === '_acpd/exit')
    expect((exit!.params as { code: number }).code).toBe(3)
  })

  it('removes its socket when the agent dies, so a dead window cannot look attachable', async () => {
    const { sock } = await start(['sh', '-c', 'exit 0'])
    // acpd exits with its agent (the tmux window closes with it), so the
    // socket must go too — a leftover file would accept connections that
    // nothing is behind, and the driver would read that as a live
    // conversation instead of noticing the window is gone.
    await new Promise((r) => setTimeout(r, 300))
    expect(fs.existsSync(sock)).toBe(false)
  })

  it('replaces a socket file left behind by a previous life of the window', async () => {
    const sock = sockPath()
    fs.mkdirSync(path.dirname(sock), { recursive: true })
    fs.writeFileSync(sock, '')

    const daemon = createAcpd({
      sockPath: sock, argv: ['cat'], cwd: process.cwd(), logStream: quiet,
    })
    daemons.push(daemon)
    await expect(daemon.listen()).resolves.toBe(sock)
  })

  it('runs the agent in the cwd it was handed, not one baked in here', async () => {
    // The launch command names the workspace because acpd is shared by both
    // runtimes and a checkout lives somewhere different under each. Getting
    // this wrong does not look like a bad directory: spawn reports ENOENT for
    // a missing cwd exactly as it does for a missing binary, so the adapter
    // "cannot be found", acpd exits 127, tmux closes the window, and the
    // worktree ends seconds after a create that reported success.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-cwd-'))
    tmpDirs.push(dir)
    const logPath = path.join(dir, 'c.jsonl')
    await start(['sh', '-c', 'pwd -P; exec cat'], { cwd: dir, logPath })
    // The record rather than a client: what the agent says before anyone
    // attaches reaches only the file, and this is said at startup.
    await waitUntil(() => fs.readFileSync(logPath, 'utf8').includes(fs.realpathSync(dir)))
  })

  it('defaults to its own directory, which is the window tmux opened', async () => {
    // Every driver pins the tmux session's start directory to the workspace,
    // so the inherited cwd is already the right one — a default that is wrong
    // under one of them is how the literal above got there in the first place.
    const sock = sockPath()
    const logPath = path.join(path.dirname(sock), 'c.jsonl')
    const daemon = createAcpd({
      sockPath: sock, argv: ['sh', '-c', 'pwd -P; exec cat'], logStream: quiet, logPath,
    })
    daemons.push(daemon)
    await daemon.listen()
    await waitUntil(() =>
      fs.readFileSync(logPath, 'utf8').includes(fs.realpathSync(process.cwd())))
  })
})
