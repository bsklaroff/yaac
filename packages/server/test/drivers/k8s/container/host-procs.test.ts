// host-procs.ts's barrel functions, run against a real temp data dir so the
// pid state file is asserted on disk. Fakes stop at the process boundary:
// `spawn` (podman), `execFile` (the `ps` identity check) and `process.kill`.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const execFileMock = vi.fn<(file: string, args: readonly string[]) => Promise<ExecResult>>()

interface FakeChild extends EventEmitter {
  pid: number | undefined
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
  /** Null while running — `killGroup` refuses to signal a reaped pid. */
  exitCode: number | null
  signalCode: string | null
}
const spawned: Array<{ file: string; args: string[]; child: FakeChild }> = []
let nextPid = 4001

vi.mock('node:child_process', () => ({
  // Other barrel modules promisify `exec` at load time; only execFile and
  // spawn are called.
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
    child.exitCode = null
    child.signalCode = null
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
import { clientLocalPath } from '@yaac/shared/paths'
import { reapOrphanedPodmanProcs, runTrackedPodman } from '#drivers/k8s/container'
import { _clearTrackedPodmanProcsForTests } from '#drivers/k8s/container/host-procs'

let dataDir: string

/** Client-local: these are host pids, and the in-cluster server has no podman. */
function statePath(): string {
  return clientLocalPath('host-podman.json')
}

/** The records a run leaves for the next one to reap. */
function readState(): Array<{ pid: number; tag: string; verb: string }> {
  return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as Array<{
    pid: number
    tag: string
    verb: string
  }>
}

function stateExists(): boolean {
  return fs.existsSync(statePath())
}

function writeState(records: Array<{ pid: number; tag: string; verb: string }>): void {
  fs.writeFileSync(statePath(), JSON.stringify(records))
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
    // Written synchronously at spawn, so a SIGKILL on the next tick still
    // leaves a record to reap.
    expect(readState()).toEqual([
      { pid: spawned[0].child.pid, tag: 'yaac-tools:abc', verb: 'build' },
    ])

    spawned[0].child.emit('close', 0)
    await expect(done).resolves.toBeUndefined()
    expect(readState()).toEqual([])
    expect(vi.mocked(pipeToServerLog)).toHaveBeenCalledWith(
      expect.anything(), '[build yaac-tools:abc] ', expect.any(Function),
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
    // The runner wraps `onLog` to keep a tail for error messages, so drive
    // a line through the wrapper.
    const piped = vi.mocked(pipeToServerLog).mock.calls.filter((c) => c[1] === '[build a:1] ').at(-1)
    piped?.[2]?.('STEP 1/3: FROM yaac-base:x')
    expect(onLog).toHaveBeenCalledWith('STEP 1/3: FROM yaac-base:x')

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

describe('reapOrphanedPodmanProcs', () => {
  it('kills a surviving podman build from a previous install and clears the file', async () => {
    writeState([{ pid: 9001, tag: 'yaac-tools:abc', verb: 'build' }])
    execFileMock.mockResolvedValue({
      stdout: 'podman build -t yaac-tools:abc /home/u/.yaac/dockerfiles\n',
      stderr: '',
    })
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig: unknown) => {
      // Dies on SIGTERM, so the signal-0 liveness check throws and there is
      // no SIGKILL.
      if (sig === 0) throw new Error('ESRCH')
      return true
    }))

    await reapOrphanedPodmanProcs()

    expect(execFileMock).toHaveBeenCalledWith('ps', ['-p', '9001', '-o', 'args='])
    expect(kill).toHaveBeenCalledWith(9001, 'SIGTERM')
    expect(kill).not.toHaveBeenCalledWith(9001, 'SIGKILL')
    expect(readState()).toEqual([])
  })

  it('skips records whose pid could signal a process group', async () => {
    // `process.kill(0)` signals our own process group and `process.kill(-n)`
    // all of group n, so these must be rejected before `ps` runs.
    writeState([
      { pid: 0, tag: 'a:1', verb: 'build' },
      { pid: -4242, tag: 'b:2', verb: 'build' },
      { pid: NaN, tag: 'c:3', verb: 'build' },
      { pid: 1.5, tag: 'd:4', verb: 'build' },
    ] as Array<{ pid: number; tag: string; verb: string }>)
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true))

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
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true))

    await reapOrphanedPodmanProcs()

    expect(kill).not.toHaveBeenCalled()
    expect(readState()).toEqual([])
  })

  it('escalates to SIGKILL when the orphan ignores SIGTERM', async () => {
    vi.useFakeTimers()
    writeState([{ pid: 9001, tag: 'yaac-tools:abc', verb: 'build' }])
    execFileMock.mockResolvedValue({ stdout: 'podman build -t yaac-tools:abc .\n', stderr: '' })
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true))

    const done = reapOrphanedPodmanProcs()
    // The record stays on disk through the grace period, so a server that
    // dies mid-kill leaves it for the next boot.
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
    // The pid is reused by another process during the grace period.
    execFileMock
      .mockResolvedValueOnce({ stdout: 'podman build -t yaac-tools:abc .\n', stderr: '' })
      .mockResolvedValue({ stdout: 'psql -h localhost\n', stderr: '' })
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true))

    const done = reapOrphanedPodmanProcs()
    await vi.advanceTimersByTimeAsync(6000)
    await done

    expect(kill).toHaveBeenCalledWith(9001, 'SIGTERM')
    expect(kill).not.toHaveBeenCalledWith(9001, 'SIGKILL')
  })

  it('no-ops without a state file, and clears a torn one', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true))
    await reapOrphanedPodmanProcs()
    expect(execFileMock).not.toHaveBeenCalled()
    // No file is created when there was none.
    expect(stateExists()).toBe(false)

    fs.writeFileSync(statePath(), '[{"pid":90')
    await reapOrphanedPodmanProcs()
    expect(execFileMock).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    // Rewritten, so the garbage is not re-read on every boot.
    expect(readState()).toEqual([])
  })
})
