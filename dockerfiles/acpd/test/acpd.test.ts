import { describe, it, expect, afterEach, vi } from 'vitest'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAcpd } from '../acpd.js'

/**
 * Drives a real child over a real socket and checks what reaches an attached
 * client and what lands in the record. The child is usually `cat`: acpd
 * parses nothing, so a byte echo exercises everything it does.
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

/** Poll until a condition holds. */
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

    a.socket.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')
    await a.waitFor((l) => l.length >= 2)
    a.socket.destroy()
    const b = connect(sock)
    await b.waitFor((l) => l.length >= 1)
    expect(parsed(b.lines)[0]).toEqual({
      jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false },
    })
  })

  it('still reports firstAttach when the previous client died before speaking', async () => {
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
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-log-')), 'c.jsonl')
    tmpDirs.push(path.dirname(logPath))
    const { sock, daemon } = await start(['cat'], { logPath })

    const a = connect(sock)
    await a.waitFor((l) => l.length >= 1)
    a.socket.write('{"said":"while attached"}\n')
    await a.waitFor((l) => l.some((line) => line.includes('while attached')))
    a.socket.destroy()
    await new Promise((r) => setTimeout(r, 50))

    daemon.child.stdin.write('{"said":"while detached"}\n')
    await new Promise((r) => setTimeout(r, 100))

    const recorded = fs.readFileSync(logPath, 'utf8')
    expect(recorded.split('\n')[0]).toContain('_acpd/life')
    expect(recorded).toContain('while attached')
    expect(recorded).toContain('while detached')
  })

  it('reopens the record through its fd after a client line, a pause and a long burst, across a rename', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-log-'))
    tmpDirs.push(dir)
    const logPath = path.join(dir, 'launch.jsonl')
    const adopted = path.join(dir, 'session.jsonl')
    // Echoes its stdin, and answers a `burst` line with 50 lines of its own,
    // 10 ms apart, so only SETTLE_MAX_MS can settle them.
    const agent = `process.stdin.on('data', (d) => {
      process.stdout.write(d)
      if (!String(d).includes('burst')) return
      let n = 0
      const t = setInterval(() => { process.stdout.write('{"said":"out"}\\n'); if (++n === 50) clearInterval(t) }, 10)
    })`
    const opens: string[] = []
    const realOpen = fs.openSync
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      if (p === logPath) opens.push(`path ${String(flags)}`)
      else if (String(p).startsWith('/dev/fd/')) opens.push(`fd ${String(flags)}`)
      return realOpen(p, flags, mode)
    }) as typeof fs.openSync)
    try {
      const { sock } = await start(['node', '-e', agent], { logPath })
      expect(opens).toEqual(['path w', 'fd a'])

      const a = connect(sock)
      await a.waitFor((l) => l.length >= 1)
      a.socket.write('{"said":"prompt"}\n')
      // The client line settles at once; the agent's echo after the pause.
      await a.waitFor((l) => l.some((line) => line.includes('prompt')))
      await new Promise((r) => setTimeout(r, 120))
      expect(opens.length).toBeGreaterThanOrEqual(4)

      // The server adopts the record under the session's name mid-conversation.
      fs.renameSync(logPath, adopted)
      a.socket.write('{"said":"burst"}\n')
      await a.waitFor((l) => l.some((line) => line.includes('burst')))
      const before = opens.length
      await new Promise((r) => setTimeout(r, 450))
      expect(opens.length).toBeGreaterThanOrEqual(before + 2)
      await a.waitFor((l) => l.filter((line) => line.includes('"out"')).length === 50)
      await new Promise((r) => setTimeout(r, 120))

      expect(fs.existsSync(logPath)).toBe(false)
      const lines = fs.readFileSync(adopted, 'utf8').trim().split('\n')
      expect(lines[0]).toContain('_acpd/life')
      const said = lines.slice(1).map((l) => (JSON.parse(l) as { said: string }).said)
      expect(said).toEqual(['prompt', 'prompt', 'burst', 'burst', ...Array<string>(50).fill('out')])
      expect(opens.slice(1).every((o) => o === 'fd a')).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('records whole lines, so one side speaking mid-line cannot split the other\'s', async () => {
    // The agent speaks the moment it sees a `!`, which the client sends
    // before finishing its line.
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-log-')), 'c.jsonl')
    tmpDirs.push(path.dirname(logPath))
    const agent = 'process.stdin.on("data", (d) => { if (String(d).includes("!")) process.stdout.write(\'{"agent":"spoke"}\\n\') })'
    const { sock } = await start(['node', '-e', agent], { logPath })

    const a = connect(sock)
    await a.waitFor((l) => l.length >= 1)
    a.socket.write('{"user":"a long line!')
    await a.waitFor((l) => l.some((line) => line.includes('spoke')))
    a.socket.write('"}\n')
    await waitUntil(() => fs.readFileSync(logPath, 'utf8').includes('long line!"}'))

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(1)
    expect(parsed(lines)).toEqual([{ agent: 'spoke' }, { user: 'a long line!' }])
  })

  it('ends a line its client abandoned, so the next client\'s first line arrives whole', async () => {
    // The agent reads lines, as an adapter does, and echoes each.
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-log-')), 'c.jsonl')
    tmpDirs.push(path.dirname(logPath))
    const agent = 'require("readline").createInterface({ input: process.stdin })'
      + '.on("line", (l) => process.stdout.write(JSON.stringify({ got: l }) + "\\n"))'
    const { sock } = await start(['node', '-e', agent], { logPath })

    const a = connect(sock)
    await a.waitFor((l) => l.length >= 1)
    a.socket.write('{"cut":"sho')
    await new Promise((r) => setTimeout(r, 50))
    a.socket.destroy()
    await new Promise((r) => setTimeout(r, 50))

    const b = connect(sock)
    await b.waitFor((l) => l.length >= 1)
    b.socket.write('{"next":"request"}\n')
    await b.waitFor((l) => l.some((line) => line.includes('next')))
    expect(parsed(b.lines)).toContainEqual({ got: '{"next":"request"}' })
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
    expect(b.lines.filter((l) => l.includes('"missed"'))).toEqual([])
    expect(fs.readFileSync(logPath, 'utf8')).toContain('"missed"')
  })

  it('records the agent\'s exit, which a detached client would never see', async () => {
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-log-')), 'c.jsonl')
    tmpDirs.push(path.dirname(logPath))
    await start(['sh', '-c', 'exit 4'], { logPath })
    await new Promise((r) => setTimeout(r, 300))

    expect(fs.readFileSync(logPath, 'utf8')).toContain('_acpd/exit')
  })

  it('restarts the agent under a fresh record when the record fails', async () => {
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-log-')), 'c.jsonl')
    tmpDirs.push(path.dirname(logPath))
    const { sock, daemon } = await start(['cat'], { logPath })

    const a = connect(sock)
    await a.waitFor((l) => l.some((line) => line.includes('_acpd/hello')))
    const firstLife = fs.readFileSync(logPath, 'utf8').split('\n')[0]
    const firstChild = daemon.child

    // Simulate a full disk: the next write to the closed fd throws EBADF.
    daemon.closeRecordForTest()
    daemon.child.stdin.write('{"triggers":"the write"}\n')

    await waitUntil(() => a.socket.destroyed)
    await waitUntil(() => daemon.child !== firstChild)

    const b = connect(sock)
    await b.waitFor((l) => l.some((line) => line.includes('_acpd/hello')))
    expect(b.lines.some((l) => l.includes('"firstAttach":true'))).toBe(true)
    const secondLife = fs.readFileSync(logPath, 'utf8').split('\n')[0]
    expect(secondLife).toContain('_acpd/life')
    expect(secondLife).not.toBe(firstLife)

    b.socket.write('{"after":"restart"}\n')
    await b.waitFor((l) => l.some((line) => line.includes('"after"')))
  })

  it('refuses an attach while the agent is being restarted', async () => {
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-log-')), 'c.jsonl')
    tmpDirs.push(path.dirname(logPath))
    // An agent that ignores SIGTERM keeps the restart open for the full grace.
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

    const during = connect(sock)
    await waitUntil(() => during.socket.destroyed)
    expect(during.lines).toEqual([])

    await waitUntil(() => daemon.child !== firstChild, 5000)
    const after = connect(sock)
    await after.waitFor((l) => l.some((line) => line.includes('_acpd/hello')))
    expect(after.lines.some((l) => l.includes('"firstAttach":true'))).toBe(true)
  })

  it('gives up rather than restarting forever when the record cannot be repaired', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-log-'))
    tmpDirs.push(dir)
    // A directory where the record should be, so every open fails.
    const logPath = path.join(dir, 'c.jsonl')
    fs.mkdirSync(logPath)
    const sock = sockPath()
    const daemon = createAcpd({
      sockPath: sock, argv: ['cat'], cwd: process.cwd(), logStream: quiet, logPath,
    })
    daemons.push(daemon)
    const exited = new Promise<number>((resolve) => daemon.onExit((code) => resolve(code)))
    await daemon.listen()

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
    // A wrong cwd makes spawn fail with ENOENT, which looks like a missing
    // binary and takes the workspace down.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpd-cwd-'))
    tmpDirs.push(dir)
    const logPath = path.join(dir, 'c.jsonl')
    await start(['sh', '-c', 'pwd -P; exec cat'], { cwd: dir, logPath })
    // Output before any attach reaches only the record.
    await waitUntil(() => fs.readFileSync(logPath, 'utf8').includes(fs.realpathSync(dir)))
  })

  it('defaults to its own directory, which is the window tmux opened', async () => {
    // Every driver starts the tmux session in the workspace.
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
