import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseListenPorts,
  diffPorts,
  isCandidatePort,
  probeHttp,
  startPortDetector,
  ensureSessionDetector,
  type PortDetectorDeps,
  type PollProcess,
} from '@/lib/session/port-detector'
import { hasSessionDetector, stopSessionForwarders } from '@/lib/session/port-forwarders'

const POLL_MARKER = '__YAAC_POLL_END__'
const flush = () => new Promise((r) => setImmediate(r))

// --- /proc/net/tcp fixtures -------------------------------------------------

const PROC_HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'

/** One /proc/net/tcp[6] data row. `ipHex` is the little-endian local address. */
function procRow(portDec: number, ipHex = '00000000', state = '0A'): string {
  const portHex = portDec.toString(16).toUpperCase().padStart(4, '0')
  return `   0: ${ipHex}:${portHex} 00000000:0000 ${state} 00000000:00000000 00:00000000  1000 0 1 1`
}

function procDump(rows: string[]): string {
  return [PROC_HEADER, ...rows].join('\n')
}

/** A full poll frame as the in-pod loop emits it: dump + marker. */
function pollFrame(ports: number[]): string {
  return procDump(ports.map((p) => procRow(p))) + `\n${POLL_MARKER}\n`
}

// --- pure helpers -----------------------------------------------------------

describe('parseListenPorts', () => {
  it('extracts loopback and any-address LISTEN ports, sorted and de-duped', () => {
    const text = procDump([
      procRow(5173, '0100007F'), // 127.0.0.1
      procRow(3000, '00000000'), // 0.0.0.0
      procRow(5173, '00000000'), // duplicate port, different bind
    ])
    expect(parseListenPorts(text)).toEqual([3000, 5173])
  })

  it('ignores non-LISTEN rows', () => {
    const text = procDump([
      procRow(3000, '00000000', '01'), // ESTABLISHED
      procRow(5173, '0100007F', '0A'), // LISTEN
    ])
    expect(parseListenPorts(text)).toEqual([5173])
  })

  it('skips sockets bound to a specific non-loopback IP', () => {
    // 192.168.1.2 → little-endian 0201A8C0; not reachable via localhost.
    expect(parseListenPorts(procDump([procRow(3000, '0201A8C0')]))).toEqual([])
  })

  it('handles IPv6 loopback (::1) and any (::)', () => {
    const text = procDump([
      procRow(8080, '00000000000000000000000001000000'), // ::1
      procRow(9090, '00000000000000000000000000000000'), // ::
    ])
    expect(parseListenPorts(text)).toEqual([8080, 9090])
  })

  it('ignores the header row and returns [] for empty input', () => {
    expect(parseListenPorts(PROC_HEADER)).toEqual([])
    expect(parseListenPorts('')).toEqual([])
  })
})

describe('diffPorts', () => {
  it('reports added and removed between two sets', () => {
    expect(diffPorts([3000, 5173], [5173, 8080])).toEqual({ added: [8080], removed: [3000] })
  })
  it('is empty when unchanged', () => {
    expect(diffPorts([3000], [3000])).toEqual({ added: [], removed: [] })
  })
})

describe('isCandidatePort', () => {
  it('accepts unprivileged ports and rejects the rest', () => {
    expect(isCandidatePort(1024)).toBe(false)
    expect(isCandidatePort(80)).toBe(false)
    expect(isCandidatePort(1025)).toBe(true)
    expect(isCandidatePort(5173)).toBe(true)
    expect(isCandidatePort(65535)).toBe(true)
    expect(isCandidatePort(65536)).toBe(false)
  })
})

describe('probeHttp', () => {
  it('returns true on the first HTTP response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 404 } as Response)
    expect(await probeHttp('http://x', { fetchImpl, sleepImpl: () => Promise.resolve() })).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries then succeeds when the server comes up late', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ status: 200 } as Response)
    expect(await probeHttp('http://x', { fetchImpl, sleepImpl: () => Promise.resolve() })).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('returns false after exhausting retries on a non-HTTP listener', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('parse error'))
    expect(await probeHttp('http://x', { retries: 3, fetchImpl, sleepImpl: () => Promise.resolve() })).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
})

// --- detector loop ----------------------------------------------------------

interface FakePoll {
  proc: PollProcess
  push: (chunk: string) => void
  exit: () => void
}

function makeFakePoll(): FakePoll {
  let dataCb: ((c: string) => void) | undefined
  let exitCb: (() => void) | undefined
  const proc: PollProcess = {
    onData: (cb) => { dataCb = cb },
    onExit: (cb) => { exitCb = cb },
    kill: vi.fn(),
  }
  return { proc, push: (c) => dataCb?.(c), exit: () => exitCb?.() }
}

function makeDeps(overrides: Partial<PortDetectorDeps> = {}): {
  deps: PortDetectorDeps
  polls: FakePoll[]
} {
  const polls: FakePoll[] = []
  const deps: PortDetectorDeps = {
    spawnPoll: vi.fn(() => { const f = makeFakePoll(); polls.push(f); return f.proc }),
    openForward: vi.fn((_job: string, cp: number) => Promise.resolve({ hostPort: cp + 10000, stop: vi.fn() })),
    probe: vi.fn(() => Promise.resolve(true)),
    isForwarded: vi.fn(() => false),
    addForward: vi.fn(),
    removeForward: vi.fn(),
    schedule: vi.fn(() => ({ cancel: vi.fn() })),
    ...overrides,
  }
  return { deps, polls }
}

describe('startPortDetector', () => {
  it('forwards, probes and registers a detected HTTP dev server', async () => {
    const { deps, polls } = makeDeps()
    const stop = startPortDetector('s1', 'job1', deps)
    expect(deps.spawnPoll).toHaveBeenCalledTimes(1)

    polls[0].push(pollFrame([5173]))
    await flush(); await flush()

    expect(deps.openForward).toHaveBeenCalledWith('job1', 5173)
    expect(deps.probe).toHaveBeenCalledWith(15173)
    expect(deps.addForward).toHaveBeenCalledWith(
      's1', { containerPort: 5173, hostPort: 15173 }, expect.any(Function),
    )
    stop()
  })

  it('tears down a forward when its port stops listening', async () => {
    const { deps, polls } = makeDeps()
    const stop = startPortDetector('s2', 'job2', deps)

    polls[0].push(pollFrame([5173]))
    await flush(); await flush()
    polls[0].push(pollFrame([])) // server gone
    await flush()

    expect(deps.removeForward).toHaveBeenCalledWith('s2', 5173)
    stop()
  })

  it('dismisses a non-HTTP listener and does not re-probe it while it stays up', async () => {
    const { deps, polls } = makeDeps({ probe: vi.fn(() => Promise.resolve(false)) })
    const openForward = deps.openForward as ReturnType<typeof vi.fn>
    const relayStop = vi.fn()
    openForward.mockResolvedValue({ hostPort: 15432, stop: relayStop })
    const stop = startPortDetector('s3', 'job3', deps)

    polls[0].push(pollFrame([5432]))
    await flush(); await flush()
    expect(deps.addForward).not.toHaveBeenCalled()
    expect(relayStop).toHaveBeenCalledTimes(1) // temporary probe relay closed

    polls[0].push(pollFrame([5432])) // still listening
    await flush(); await flush()
    expect(openForward).toHaveBeenCalledTimes(1) // not re-probed
    stop()
  })

  it('re-probes a dismissed port after it disappears and comes back', async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const { deps, polls } = makeDeps({ probe })
    const stop = startPortDetector('s4', 'job4', deps)

    polls[0].push(pollFrame([4000])); await flush(); await flush() // dismissed
    polls[0].push(pollFrame([])); await flush()                    // gone → cleared
    polls[0].push(pollFrame([4000])); await flush(); await flush() // back → re-probed

    expect(probe).toHaveBeenCalledTimes(2)
    expect(deps.addForward).toHaveBeenCalledTimes(1)
    stop()
  })

  it('skips ports already covered by a static forward', async () => {
    const { deps, polls } = makeDeps({ isForwarded: vi.fn(() => true) })
    const stop = startPortDetector('s5', 'job5', deps)
    polls[0].push(pollFrame([3000])); await flush(); await flush()
    expect(deps.openForward).not.toHaveBeenCalled()
    stop()
  })

  it('skips privileged ports', async () => {
    const { deps, polls } = makeDeps()
    const stop = startPortDetector('s6', 'job6', deps)
    polls[0].push(pollFrame([80])); await flush(); await flush()
    expect(deps.openForward).not.toHaveBeenCalled()
    stop()
  })

  it('respawns the poll loop with backoff when it exits unexpectedly', () => {
    const { deps, polls } = makeDeps()
    const stop = startPortDetector('s7', 'job7', deps)

    polls[0].exit()
    expect(deps.schedule).toHaveBeenCalledTimes(1)
    const [fn, ms] = (deps.schedule as ReturnType<typeof vi.fn>).mock.calls[0] as [() => void, number]
    expect(ms).toBe(1000)
    fn()
    expect(deps.spawnPoll).toHaveBeenCalledTimes(2)
    stop()
  })

  it('stop() kills the child and cancels a pending respawn', () => {
    const cancel = vi.fn()
    const { deps, polls } = makeDeps({ schedule: vi.fn(() => ({ cancel })) })
    const stop = startPortDetector('s8', 'job8', deps)
    polls[0].exit()          // schedules a respawn
    stop()
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

describe('ensureSessionDetector', () => {
  afterEach(() => {
    stopSessionForwarders('sess-ens-1')
  })

  it('starts a detector once and is idempotent', () => {
    const { deps } = makeDeps()
    expect(hasSessionDetector('sess-ens-1')).toBe(false)

    ensureSessionDetector('sess-ens-1', 'job', deps)
    expect(hasSessionDetector('sess-ens-1')).toBe(true)
    expect(deps.spawnPoll).toHaveBeenCalledTimes(1)

    ensureSessionDetector('sess-ens-1', 'job', deps)
    expect(deps.spawnPoll).toHaveBeenCalledTimes(1) // no second detector

    stopSessionForwarders('sess-ens-1')
    expect(hasSessionDetector('sess-ens-1')).toBe(false)
  })
})
