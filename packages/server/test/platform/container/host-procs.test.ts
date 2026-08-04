// The three barrel entry points of host-procs.ts. Everything is exercised
// through them against a real temp data dir, so the state file that carries
// pids across a restart is asserted as bytes on disk rather than mocked —
// that file is the whole mechanism. The fakes start at the process boundary:
// `spawn` (the podman child), `execFile` (the `ps` identity probe) and
// `process.kill`.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const execFileMock = vi.fn<(file: string, args: readonly string[]) => Promise<ExecResult>>()

interface FakeChild extends EventEmitter {
  pid: number | undefined
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}
const spawned: Array<{ file: string; args: string[]; child: FakeChild }> = []
let nextPid = 4001

vi.mock('node:child_process', () => ({
  // The barrel pulls in runtime.ts, which reaches kubectl.ts; both promisify
  // a child_process binding at module eval. Only the two below are called.
  exec: vi.fn(),
  execFile: (
    file: string,
    args: readonly string[],
    opts: unknown,
    cb?: ExecCallback,
  ) => {
    const actualCb = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void execFileMock(file, args).then(
      (res) => actualCb(null, res),
      (err: unknown) => actualCb(err),
    )
  },
  spawn: (file: string, args: string[]) => {
    const child = new EventEmitter() as FakeChild
    child.pid = nextPid++
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn()
    spawned.push({ file, args, child })
    return child
  },
}))

vi.mock('#log', () => ({
  serverLog: vi.fn(),
  pipeToServerLog: vi.fn(),
}))

import { pipeToServerLog } from '#log'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import {
  killTrackedPodmanProcs,
  reapOrphanedPodmanProcs,
  runTrackedPodman,
} from '#platform/container'
import { _clearTrackedPodmanProcsForTests } from '#platform/container/host-procs'

let dataDir: string

/** Records the server persists so a successor can reap what it left behind. */
function readState(): Array<{ pid: number; tag: string; verb: string }> {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'host-podman.json'), 'utf8')) as Array<{
    pid: number
    tag: string
    verb: string
  }>
}

function stateExists(): boolean {
  return fs.existsSync(path.join(dataDir, 'host-podman.json'))
}

function writeState(records: Array<{ pid: number; tag: string; verb: string }>): void {
  fs.writeFileSync(path.join(dataDir, 'host-podman.json'), JSON.stringify(records))
}

beforeEach(async () => {
  dataDir = await createTempDataDir()
  spawned.length = 0
  nextPid = 4001
  execFileMock.mockReset()
  _clearTrackedPodmanProcsForTests()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await cleanupTempDir(dataDir)
})

describe('runTrackedPodman', () => {
  it('runs podman, records the pid for the run, and clears it on success', async () => {
    const done = runTrackedPodman(['build', '-t', 'yaac-tools:abc', '.'], {
      tag: 'yaac-tools:abc',
      logPrefix: '[build yaac-tools:abc] ',
      timeoutMs: 600_000,
    })

    expect(spawned).toHaveLength(1)
    expect(spawned[0].file).toBe('podman')
    expect(spawned[0].args).toEqual(['build', '-t', 'yaac-tools:abc', '.'])
    // Written synchronously at spawn: a SIGKILL landing on the very next
    // tick must still leave a reapable record behind.
    expect(readState()).toEqual([
      { pid: spawned[0].child.pid, tag: 'yaac-tools:abc', verb: 'build' },
    ])

    spawned[0].child.emit('close', 0)
    await expect(done).resolves.toBeUndefined()
    expect(readState()).toEqual([])
    expect(vi.mocked(pipeToServerLog)).toHaveBeenCalledWith(
      expect.anything(), '[build yaac-tools:abc] ', undefined,
    )
  })

  it('tracks concurrent runs independently and threads onLog through', async () => {
    const onLog = vi.fn()
    const build = runTrackedPodman(['build', '-t', 'a:1', '.'], {
      tag: 'a:1', logPrefix: '[build a:1] ', onLog, timeoutMs: 1000,
    })
    const push = runTrackedPodman(['push', 'b:2'], {
      tag: 'b:2', logPrefix: '[push b:2] ', timeoutMs: 1000,
    })
    expect(readState().map((r) => r.tag)).toEqual(['a:1', 'b:2'])
    expect(readState().map((r) => r.verb)).toEqual(['build', 'push'])
    expect(vi.mocked(pipeToServerLog)).toHaveBeenCalledWith(
      expect.anything(), '[build a:1] ', onLog,
    )

    spawned[0].child.emit('close', 0)
    await build
    expect(readState().map((r) => r.tag)).toEqual(['b:2'])
    spawned[1].child.emit('close', 0)
    await push
    expect(readState()).toEqual([])
  })

  it('rejects with the podman verb and exit code, and stops tracking', async () => {
    const done = runTrackedPodman(['build', '-t', 'a:1', '.'], {
      tag: 'a:1', logPrefix: '[build a:1] ', timeoutMs: 1000,
    })
    spawned[0].child.emit('close', 125)
    await expect(done).rejects.toThrow('podman build exited with code 125')
    expect(readState()).toEqual([])
  })

  it('rejects and stops tracking when the spawn itself fails', async () => {
    const done = runTrackedPodman(['push', 'a:1'], {
      tag: 'a:1', logPrefix: '[push a:1] ', timeoutMs: 1000,
    })
    spawned[0].child.emit('error', new Error('ENOENT podman'))
    await expect(done).rejects.toThrow('ENOENT podman')
    expect(readState()).toEqual([])
  })
})

describe('killTrackedPodmanProcs', () => {
  it('SIGTERMs every in-flight podman child', () => {
    void runTrackedPodman(['build', '-t', 'a:1', '.'], {
      tag: 'a:1', logPrefix: '', timeoutMs: 1000,
    }).catch(() => {})
    void runTrackedPodman(['push', 'b:2'], {
      tag: 'b:2', logPrefix: '', timeoutMs: 1000,
    }).catch(() => {})

    killTrackedPodmanProcs()

    expect(spawned[0].child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(spawned[1].child.kill).toHaveBeenCalledWith('SIGTERM')
    // The records stay on disk: the shutdown path exits without waiting for
    // the children, so only the next boot's sweep — which re-verifies each
    // pid against `ps` — is allowed to clear them.
    expect(readState().map((r) => r.tag)).toEqual(['a:1', 'b:2'])
  })

  it('is a no-op with nothing in flight', () => {
    expect(() => killTrackedPodmanProcs()).not.toThrow()
    expect(stateExists()).toBe(false)
  })
})

describe('reapOrphanedPodmanProcs', () => {
  it('kills a surviving podman build from a previous server and clears the file', async () => {
    writeState([{ pid: 9001, tag: 'yaac-tools:abc', verb: 'build' }])
    execFileMock.mockResolvedValue({
      stdout: 'podman build -t yaac-tools:abc /home/u/.yaac/dockerfiles\n',
      stderr: '',
    })
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig: unknown) => {
      // Dead as soon as it is signalled: the liveness probe after SIGTERM
      // throws, which is how terminate() decides not to escalate.
      if (sig === 0) throw new Error('ESRCH')
      return true
    }) as typeof process.kill)

    await reapOrphanedPodmanProcs()

    expect(execFileMock).toHaveBeenCalledWith('ps', ['-p', '9001', '-o', 'args='])
    expect(kill).toHaveBeenCalledWith(9001, 'SIGTERM')
    expect(kill).not.toHaveBeenCalledWith(9001, 'SIGKILL')
    expect(readState()).toEqual([])
  })

  it('skips records whose pid could signal a process group', async () => {
    // `process.kill(0, …)` hits our own process group and `process.kill(-n,
    // …)` hits all of group n, so a crashed writer's garbage must be
    // rejected before `ps` ever sees it.
    writeState([
      { pid: 0, tag: 'a:1', verb: 'build' },
      { pid: -4242, tag: 'b:2', verb: 'build' },
      { pid: NaN, tag: 'c:3', verb: 'build' },
      { pid: 1.5, tag: 'd:4', verb: 'build' },
    ] as Array<{ pid: number; tag: string; verb: string }>)
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)

    await reapOrphanedPodmanProcs()

    expect(execFileMock).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it('leaves a reused pid alone when it is no longer our podman build', async () => {
    writeState([
      { pid: 9001, tag: 'yaac-tools:abc', verb: 'build' },
      { pid: 9002, tag: 'yaac-base:def', verb: 'build' },
    ])
    // 9001 exited and the pid was handed to something else; 9002 is gone
    // entirely, so `ps` exits non-zero.
    execFileMock.mockImplementation((_file, args) => {
      if (args[1] === '9001') return Promise.resolve({ stdout: 'vim notes.md\n', stderr: '' })
      return Promise.reject(new Error('ps: no such process'))
    })
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)

    await reapOrphanedPodmanProcs()

    expect(kill).not.toHaveBeenCalled()
    expect(readState()).toEqual([])
  })

  it('escalates to SIGKILL when the orphan ignores SIGTERM', async () => {
    vi.useFakeTimers()
    writeState([{ pid: 9001, tag: 'yaac-tools:abc', verb: 'build' }])
    execFileMock.mockResolvedValue({ stdout: 'podman build -t yaac-tools:abc .\n', stderr: '' })
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)

    const done = reapOrphanedPodmanProcs()
    // A wedged orphan holds the sweep for the full grace period. Its record
    // must still be on disk for that whole time: a server that dies mid-kill
    // has to leave the survivors for the next boot to find.
    await vi.advanceTimersByTimeAsync(2000)
    expect(readState().map((r) => r.pid)).toEqual([9001])

    // 25 chained 200ms polls, each scheduled as the previous resolves.
    await vi.advanceTimersByTimeAsync(6000)
    await done

    expect(kill).toHaveBeenCalledWith(9001, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(9001, 'SIGKILL')
    expect(readState()).toEqual([])
  })

  it('does not SIGKILL a pid that stopped being ours during the grace period', async () => {
    vi.useFakeTimers()
    writeState([{ pid: 9001, tag: 'yaac-tools:abc', verb: 'build' }])
    // Ours at the identity check, something else by the time SIGTERM has
    // gone unanswered — the pid was recycled inside the grace window.
    execFileMock
      .mockResolvedValueOnce({ stdout: 'podman build -t yaac-tools:abc .\n', stderr: '' })
      .mockResolvedValue({ stdout: 'psql -h localhost\n', stderr: '' })
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)

    const done = reapOrphanedPodmanProcs()
    await vi.advanceTimersByTimeAsync(6000)
    await done

    expect(kill).toHaveBeenCalledWith(9001, 'SIGTERM')
    expect(kill).not.toHaveBeenCalledWith(9001, 'SIGKILL')
  })

  it('no-ops without a state file, and clears a torn one', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)
    await reapOrphanedPodmanProcs()
    expect(execFileMock).not.toHaveBeenCalled()
    // Nothing was there, so nothing is written — no empty file per boot.
    expect(stateExists()).toBe(false)

    fs.writeFileSync(path.join(dataDir, 'host-podman.json'), '[{"pid":90')
    await reapOrphanedPodmanProcs()
    expect(execFileMock).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    // Rewritten, so a garbage file isn't re-read on every boot from now on.
    expect(readState()).toEqual([])
  })
})
