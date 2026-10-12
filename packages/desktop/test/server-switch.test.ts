import { describe, it, expect, vi, type Mock } from 'vitest'
import {
  addServerRemote,
  applyServerSwitch,
  disconnect,
  getServerTargets,
  parseServerSelection,
  removeServer,
  restoreSelection,
  serverHealth,
  type ServerSwitchDeps,
} from '#server-switch'
import { IdentityRejectedError, type ServerConfig } from '@yaac/shared/server-config'

const CFG: ServerConfig = {
  url: 'https://a.ts.net',
  saved: [
    { url: 'https://a.ts.net' },
    { url: 'https://b.ts.net' },
  ],
}

function makeDeps(cfg: ServerConfig | null): Omit<ServerSwitchDeps, 'writeServerConfig' | 'probeServer'> & {
  writeServerConfig: Mock<ServerSwitchDeps['writeServerConfig']>
  probeServer: Mock<ServerSwitchDeps['probeServer']>
} {
  return {
    readServerConfig: vi.fn().mockResolvedValue(cfg),
    writeServerConfig: vi.fn().mockResolvedValue(undefined),
    // A minimal copy of withServerSelected's contract.
    select: (existing, url) => ({
      url,
      saved: [{ url }, ...(existing?.saved ?? []).filter((s) => s.url !== url)],
    }),
    probeServer: vi.fn().mockResolvedValue({ buildId: 'b' }),
    normalizeUrl: (raw: string) => {
      const u = new URL(raw)
      if (u.pathname !== '/' || u.search || u.hash) throw new Error(`server URL must be a bare origin (no path/query/fragment): ${raw}`)
      return u.origin
    },
  }
}

describe('parseServerSelection', () => {
  it('accepts a url and rejects everything else', () => {
    expect(parseServerSelection({ url: 'https://a.ts.net' })).toEqual({ url: 'https://a.ts.net' })
    expect(parseServerSelection({ kind: 'local' })).toBeNull()
    expect(parseServerSelection({ url: '' })).toBeNull()
    expect(parseServerSelection({ url: 42 })).toBeNull()
    expect(parseServerSelection('https://a.ts.net')).toBeNull()
    expect(parseServerSelection(null)).toBeNull()
  })
})

describe('getServerTargets', () => {
  it('reports nothing selected and nothing saved when unconfigured', async () => {
    expect(await getServerTargets(makeDeps(null))).toEqual({ current: null, saved: [] })
  })

  it('reports the selected origin as current and lists saved origins only', async () => {
    expect(await getServerTargets(makeDeps(CFG))).toEqual({
      current: 'https://a.ts.net',
      saved: ['https://a.ts.net', 'https://b.ts.net'],
    })
  })

  it('reports nothing selected when the config is deselected, keeping the rows', async () => {
    expect(await getServerTargets(makeDeps({ ...CFG, url: '' }))).toEqual({
      current: null,
      saved: ['https://a.ts.net', 'https://b.ts.net'],
    })
  })
})

describe('applyServerSwitch', () => {
  it('probes a saved server, then selects it', async () => {
    const deps = makeDeps({ ...CFG, url: '' })
    expect(await applyServerSwitch({ url: 'https://b.ts.net' }, deps)).toEqual({ ok: true })
    expect(deps.probeServer).toHaveBeenCalledWith('https://b.ts.net')
    const written = deps.writeServerConfig.mock.calls[0][0]
    expect(written).toMatchObject({ url: 'https://b.ts.net' })
    expect(written.saved).toContainEqual({ url: 'https://a.ts.net' })
  })

  it('re-selecting the already-selected server is a real retry, not a no-op', async () => {
    // On the disconnected page this is the retry button.
    const deps = makeDeps(CFG)
    expect(await applyServerSwitch({ url: 'https://a.ts.net' }, deps)).toEqual({ ok: true })
    expect(deps.probeServer).toHaveBeenCalledWith('https://a.ts.net')
    expect(deps.writeServerConfig).toHaveBeenCalledTimes(1)
  })

  it('a failed probe surfaces its message and leaves the config untouched', async () => {
    const deps = makeDeps(CFG)
    deps.probeServer.mockRejectedValue(new Error('cannot reach https://b.ts.net'))
    expect(await applyServerSwitch({ url: 'https://b.ts.net' }, deps))
      .toEqual({ ok: false, error: 'cannot reach https://b.ts.net' })
    expect(deps.writeServerConfig).not.toHaveBeenCalled()
  })

  it('an unknown origin is rejected', async () => {
    const deps = makeDeps(CFG)
    expect(await applyServerSwitch({ url: 'https://nope.ts.net' }, deps))
      .toEqual({ ok: false, error: 'unknown server: https://nope.ts.net' })
    expect(deps.writeServerConfig).not.toHaveBeenCalled()
  })
})

describe('addServerRemote', () => {
  it('normalizes, probes, and selects the new server', async () => {
    const deps = makeDeps(CFG)
    expect(await addServerRemote('https://c.ts.net/', deps)).toEqual({ ok: true })
    expect(deps.probeServer).toHaveBeenCalledWith('https://c.ts.net')
    expect(deps.writeServerConfig).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://c.ts.net',
    }))
  })

  it('accepts a loopback origin — a server on this machine is not special', async () => {
    const deps = makeDeps(null)
    expect(await addServerRemote('http://127.0.0.1:8787', deps)).toEqual({ ok: true })
    expect(deps.writeServerConfig).toHaveBeenCalledWith(expect.objectContaining({
      url: 'http://127.0.0.1:8787',
    }))
  })

  it('rejects a non-origin URL before any probe', async () => {
    const deps = makeDeps(null)
    const outcome = await addServerRemote('https://c.ts.net/path', deps)
    expect(outcome).toEqual({ ok: false, error: expect.stringMatching(/bare origin/) as string })
    expect(deps.probeServer).not.toHaveBeenCalled()
  })

  it('a failed probe surfaces its message without persisting', async () => {
    const deps = makeDeps(null)
    deps.probeServer.mockRejectedValue(new Error('https://c.ts.net refused to identify this device'))
    expect(await addServerRemote('https://c.ts.net', deps))
      .toEqual({ ok: false, error: 'https://c.ts.net refused to identify this device' })
    expect(deps.writeServerConfig).not.toHaveBeenCalled()
  })
})

describe('removeServer', () => {
  it('forgets a saved server, keeping the selection', async () => {
    const deps = makeDeps(CFG)
    expect(await removeServer({ url: 'https://b.ts.net' }, deps)).toEqual({ ok: true })
    expect(deps.writeServerConfig).toHaveBeenCalledWith({
      url: 'https://a.ts.net', saved: [{ url: 'https://a.ts.net' }],
    })
  })

  it('refuses the selected server and leaves the config untouched', async () => {
    const deps = makeDeps(CFG)
    expect(await removeServer({ url: 'https://a.ts.net' }, deps))
      .toEqual({ ok: false, error: expect.stringMatching(/switch to another server/) as string })
    expect(deps.writeServerConfig).not.toHaveBeenCalled()
  })

  it('forgets any saved server while none is selected', async () => {
    const deps = makeDeps({ ...CFG, url: '' })
    expect(await removeServer({ url: 'https://a.ts.net' }, deps)).toEqual({ ok: true })
    expect(deps.writeServerConfig).toHaveBeenCalledWith({
      url: '', saved: [{ url: 'https://b.ts.net' }],
    })
  })

  it('an absent or malformed config is refused, not overwritten', async () => {
    const deps = makeDeps(null)
    expect(await removeServer({ url: 'https://a.ts.net' }, deps))
      .toEqual({ ok: false, error: 'unknown server: https://a.ts.net' })
    expect(deps.writeServerConfig).not.toHaveBeenCalled()
  })

  it('an unknown origin is rejected', async () => {
    const deps = makeDeps(CFG)
    expect(await removeServer({ url: 'https://nope.ts.net' }, deps))
      .toEqual({ ok: false, error: 'unknown server: https://nope.ts.net' })
    expect(deps.writeServerConfig).not.toHaveBeenCalled()
  })
})

describe('restoreSelection', () => {
  it('puts back the remote selection a `yaac server start` replaced, keeping what it saved', async () => {
    const started: ServerConfig = {
      url: 'http://127.0.0.1:8787',
      saved: [{ url: 'http://127.0.0.1:8787' }, ...CFG.saved],
    }
    const deps = makeDeps(started)
    await restoreSelection(CFG, deps)
    expect(deps.writeServerConfig).toHaveBeenCalledWith({ ...started, url: CFG.url })
  })
  it('writes nothing when the selection is unchanged, or nothing is configured', async () => {
    for (const cfg of [CFG, null]) {
      const deps = makeDeps(cfg)
      await restoreSelection(CFG, deps)
      expect(deps.writeServerConfig).not.toHaveBeenCalled()
    }
  })
})

describe('serverHealth', () => {
  it('says which saved servers do not answer and which refuse this device, and why', async () => {
    const deps = makeDeps({ ...CFG, saved: [...CFG.saved, { url: 'https://c.ts.net' }] })
    deps.probeServer.mockImplementation((origin) => origin === 'https://b.ts.net'
      ? Promise.reject(new Error('cannot reach https://b.ts.net: fetch failed'))
      : origin === 'https://c.ts.net'
        ? Promise.reject(new IdentityRejectedError('https://c.ts.net refused to identify this device'))
        : Promise.resolve({ buildId: 'b', principal: { kind: 'local', userId: 'u1' } }))
    expect(await serverHealth(deps)).toEqual({
      'https://b.ts.net': { kind: 'stopped' },
      'https://c.ts.net': { kind: 'refused', reason: 'https://c.ts.net refused to identify this device' },
    })
    expect(await serverHealth(makeDeps(null))).toEqual({})
  })
})

describe('disconnect', () => {
  it('deselects the selected server and keeps every saved one, and refuses when none is selected', async () => {
    const deps = makeDeps(CFG)
    expect(await disconnect(deps)).toEqual({ ok: true })
    expect(deps.writeServerConfig).toHaveBeenCalledWith({ ...CFG, url: '' })
    const off = makeDeps({ ...CFG, url: '' })
    expect(await disconnect(off)).toEqual({ ok: false, error: 'no server is selected' })
    expect(off.writeServerConfig).not.toHaveBeenCalled()
  })
})
