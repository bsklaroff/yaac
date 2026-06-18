import { describe, it, expect } from 'vitest'
import net from 'node:net'
import {
  DEFAULT_DAEMON_PORT,
  MAX_PORT_PROBES,
  resolveDaemonPort,
  bindWithAutoIncrement,
  isAddrInUseError,
} from '@/shared/daemon-port'

const inUse = (): Error => Object.assign(new Error('in use'), { code: 'EADDRINUSE' })

describe('DEFAULT_DAEMON_PORT', () => {
  it('is a fixed, well-known loopback port', () => {
    // A stable default is the whole point — pin it so a change is deliberate
    // and the Vite dev-server fallback (vite.config.ts) stays in sync.
    expect(DEFAULT_DAEMON_PORT).toBe(8787)
  })
})

describe('resolveDaemonPort', () => {
  it('prefers an explicit --port over the env and the default', () => {
    expect(resolveDaemonPort(1234, { YAAC_DAEMON_PORT: '9999' })).toBe(1234)
  })

  it('allows --port 0 (OS-assigned ephemeral)', () => {
    expect(resolveDaemonPort(0, { YAAC_DAEMON_PORT: '9999' })).toBe(0)
  })

  it('falls back to YAAC_DAEMON_PORT when no --port is given', () => {
    expect(resolveDaemonPort(undefined, { YAAC_DAEMON_PORT: '9999' })).toBe(9999)
  })

  it('falls back to the default when neither --port nor env is set', () => {
    expect(resolveDaemonPort(undefined, {})).toBe(DEFAULT_DAEMON_PORT)
  })

  it('treats an empty YAAC_DAEMON_PORT as unset', () => {
    expect(resolveDaemonPort(undefined, { YAAC_DAEMON_PORT: '' })).toBe(DEFAULT_DAEMON_PORT)
  })

  it('throws on a non-numeric YAAC_DAEMON_PORT', () => {
    expect(() => resolveDaemonPort(undefined, { YAAC_DAEMON_PORT: 'nope' })).toThrow(/YAAC_DAEMON_PORT/)
  })

  it('throws on an out-of-range YAAC_DAEMON_PORT', () => {
    expect(() => resolveDaemonPort(undefined, { YAAC_DAEMON_PORT: '70000' })).toThrow(/between 0 and 65535/)
  })

  it('throws on a NaN --port (e.g. `--port abc` parsed to NaN)', () => {
    expect(() => resolveDaemonPort(Number.NaN)).toThrow(/--port/)
  })
})

describe('bindWithAutoIncrement', () => {
  it('returns the first port when it binds', async () => {
    const tried: number[] = []
    const result = await bindWithAutoIncrement(8787, (p) => {
      tried.push(p)
      return Promise.resolve(`bound:${p}`)
    })
    expect(result).toBe('bound:8787')
    expect(tried).toEqual([8787])
  })

  it('increments past in-use ports to the next free one', async () => {
    const tried: number[] = []
    const busy = new Set([8787, 8788, 8789])
    const result = await bindWithAutoIncrement(8787, (p) => {
      tried.push(p)
      return busy.has(p) ? Promise.reject(inUse()) : Promise.resolve(`bound:${p}`)
    })
    expect(result).toBe('bound:8790')
    expect(tried).toEqual([8787, 8788, 8789, 8790])
  })

  it('binds port 0 exactly once without incrementing', async () => {
    const tried: number[] = []
    const result = await bindWithAutoIncrement(0, (p) => {
      tried.push(p)
      return Promise.resolve(`bound:${p}`)
    })
    expect(result).toBe('bound:0')
    expect(tried).toEqual([0])
  })

  it('propagates a non-EADDRINUSE error immediately', async () => {
    let calls = 0
    await expect(bindWithAutoIncrement(8787, () => {
      calls++
      return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
    })).rejects.toThrow(/denied/)
    expect(calls).toBe(1)
  })

  it('throws after probing MAX_PORT_PROBES busy ports', async () => {
    let calls = 0
    await expect(bindWithAutoIncrement(8787, () => {
      calls++
      return Promise.reject(inUse())
    })).rejects.toThrow(/no free port found/)
    expect(calls).toBe(MAX_PORT_PROBES)
  })

  it('walks past a really-bound socket to the next free port', async () => {
    const blocker = net.createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
    const addr = blocker.address()
    if (!addr || typeof addr === 'string') throw new Error('bad address')
    const bound: net.Server[] = []
    try {
      const port = await bindWithAutoIncrement(addr.port, (p) =>
        new Promise<number>((resolve, reject) => {
          const s = net.createServer()
          s.once('error', reject)
          s.listen(p, '127.0.0.1', () => { bound.push(s); resolve(p) })
        }))
      // addr.port is held by `blocker`, so the search lands on the next port.
      expect(port).toBe(addr.port + 1)
    } finally {
      for (const s of bound) await new Promise<void>((r) => s.close(() => r()))
      await new Promise<void>((r) => blocker.close(() => r()))
    }
  })
})

describe('isAddrInUseError', () => {
  it('returns true for a real EADDRINUSE error', async () => {
    // Bind an OS-assigned port, then try to bind the same port again — the
    // second listen fails with EADDRINUSE, the exact error the daemon must
    // classify so it refuses to silently pick a different port.
    const first = net.createServer()
    await new Promise<void>((resolve) => first.listen(0, '127.0.0.1', () => resolve()))
    const addr = first.address()
    if (!addr || typeof addr === 'string') throw new Error('bad address')

    const err = await new Promise<unknown>((resolve) => {
      const second = net.createServer()
      second.once('error', (e) => resolve(e))
      second.listen(addr.port, '127.0.0.1')
    })
    try {
      expect(isAddrInUseError(err)).toBe(true)
    } finally {
      await new Promise<void>((resolve) => first.close(() => resolve()))
    }
  })

  it('returns false for an unrelated error code', () => {
    expect(isAddrInUseError(Object.assign(new Error('nope'), { code: 'ECONNREFUSED' }))).toBe(false)
  })

  it('returns false for an error without a code', () => {
    expect(isAddrInUseError(new Error('plain'))).toBe(false)
  })

  it('returns false for null and undefined', () => {
    expect(isAddrInUseError(null)).toBe(false)
    expect(isAddrInUseError(undefined)).toBe(false)
  })
})
