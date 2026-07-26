import { describe, expect, it } from 'vitest'
import {
  applyRestore,
  backendBinaries,
  detectBackend,
  ensurePreroutingJump,
  readIpRoutes,
  scoreBackendDump,
  teardownChain,
  type IptablesRunner,
} from 'yaac-netd/iptables'

function runner(impl: (file: string, args: string[]) => Promise<string>): IptablesRunner & {
  calls: Array<[string, string[], { input?: string } | undefined]>
} {
  const calls: Array<[string, string[], { input?: string } | undefined]> = []
  return {
    calls,
    run: async (file, args, opts) => {
      calls.push([file, args, opts])
      return { stdout: await impl(file, args), stderr: '' }
    },
  }
}

describe('backendBinaries', () => {
  it('names the save/restore pair for each backend', () => {
    expect(backendBinaries('legacy')).toEqual({
      iptables: 'iptables-legacy', save: 'iptables-legacy-save', restore: 'iptables-legacy-restore',
    })
    expect(backendBinaries('nft').restore).toBe('iptables-nft-restore')
  })
})

describe('scoreBackendDump', () => {
  it('treats the presence of Calico chains as decisive', () => {
    expect(scoreBackendDump('-A cali-PREROUTING -j cali-fip-dnat'))
      .toBeGreaterThan(scoreBackendDump('-A X\n'.repeat(100)))
  })

  it('otherwise scores by rule count', () => {
    expect(scoreBackendDump('-A A\n-A B\n')).toBe(2)
    expect(scoreBackendDump('')).toBe(0)
  })
})

describe('detectBackend', () => {
  it('picks the backend carrying Calico\'s chains', async () => {
    // The failure this prevents is silent: writing to the backend the node
    // does NOT use produces a chain that exists, counts nothing, and is
    // never consulted by the packet path.
    const r = runner((file) =>
      Promise.resolve(file.startsWith('iptables-nft') ? '-A cali-PREROUTING -j x' : ''))
    await expect(detectBackend(r)).resolves.toBe('nft')
  })

  it('falls back to legacy when neither backend has Calico', async () => {
    await expect(detectBackend(runner(() => Promise.resolve('')))).resolves.toBe('legacy')
  })

  it('never picks a backend whose binaries are missing', async () => {
    const r = runner((file) => file.startsWith('iptables-nft')
      ? Promise.reject(new Error('not found'))
      : Promise.resolve(''))
    await expect(detectBackend(r)).resolves.toBe('legacy')
  })
})

describe('ensurePreroutingJump', () => {
  it('puts -t nat before the command verb', async () => {
    // iptables rejects `-A -t nat PREROUTING`; the table must come first.
    const r = runner(() => Promise.reject(new Error('no such rule')))
    await ensurePreroutingJump('legacy', 'YAAC_REDIRECT', r).catch(() => {})
    for (const [, args] of r.calls) {
      expect(args.slice(0, 2)).toEqual(['-t', 'nat'])
    }
  })

  it('APPENDS the jump — never inserts, so it cannot race Felix for position', async () => {
    const r = runner((_f, args) => args.includes('-C')
      ? Promise.reject(new Error('absent'))
      : Promise.resolve(''))
    await ensurePreroutingJump('legacy', 'YAAC_REDIRECT', r)
    const add = r.calls.find(([, args]) => args.includes('-A'))
    expect(add?.[1]).toEqual(['-t', 'nat', '-A', 'PREROUTING', '-j', 'YAAC_REDIRECT'])
    expect(r.calls.some(([, args]) => args.includes('-I'))).toBe(false)
  })

  it('is a no-op when the jump is already present', async () => {
    const r = runner(() => Promise.resolve(''))
    await ensurePreroutingJump('legacy', 'YAAC_REDIRECT', r)
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0][1]).toContain('-C')
  })
})

describe('applyRestore', () => {
  it('feeds the document to the backend\'s restore binary on stdin', async () => {
    const r = runner(() => Promise.resolve(''))
    await applyRestore('nft', '*nat\n:YAAC_RDR_x - [0:0]\nCOMMIT\n', r)
    expect(r.calls).toHaveLength(1)
    const [file, , opts] = r.calls[0]
    expect(file).toBe('iptables-nft-restore')
    expect(opts?.input).toContain('COMMIT')
  })

  it('always passes --noflush so only our chain changes', async () => {
    // Without it, restore flushes every chain in the table it names —
    // including Calico's and kube-proxy's, i.e. the node's whole datapath.
    const r = runner(() => Promise.resolve(''))
    await applyRestore('legacy', '*nat\nCOMMIT\n', r)
    expect(r.calls[0][1]).toEqual(['--noflush'])
  })

  it('propagates a rejected document rather than reporting success', async () => {
    const r = runner(() => Promise.reject(new Error('line 3 failed')))
    await expect(applyRestore('legacy', 'bad', r)).rejects.toThrow(/line 3 failed/)
  })
})

describe('teardownChain', () => {
  it('unlinks before flushing and deleting', async () => {
    // -X fails on a chain that is still referenced, so the jump must go first.
    const r = runner(() => Promise.resolve(''))
    await teardownChain('legacy', 'YAAC_RDR_x', r)
    expect(r.calls.map(([, args]) => args[2])).toEqual(['-D', '-F', '-X'])
    expect(r.calls[0][1]).toEqual(['-t', 'nat', '-D', 'PREROUTING', '-j', 'YAAC_RDR_x'])
  })

  it('treats a missing chain as success', async () => {
    // Shutdown teardown runs on paths where the chain may never have been
    // created; a throw here would mask the real exit reason.
    const r = runner(() => Promise.reject(new Error('No chain/target/match')))
    await expect(teardownChain('nft', 'YAAC_RDR_x', r)).resolves.toBeUndefined()
    expect(r.calls).toHaveLength(3)
  })
})

describe('readIpRoutes', () => {
  it('returns the routing table verbatim for parsePodVeths', async () => {
    const table = '10.244.0.9 dev calia132c78e002 scope link\n'
    const r = runner(() => Promise.resolve(table))
    await expect(readIpRoutes(r)).resolves.toBe(table)
    expect(r.calls[0].slice(0, 2)).toEqual(['ip', ['route', 'show']])
  })
})
