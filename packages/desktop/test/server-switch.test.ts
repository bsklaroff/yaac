import { describe, it, expect, vi } from 'vitest'
import {
  addServerRemote,
  applyServerSwitch,
  getServerTargets,
  parseServerSelection,
  type ServerSwitchDeps,
} from '#server-switch'
import type { ServerConfig } from '@yaac/shared/server-config'

const CFG: ServerConfig = {
  url: 'https://a.ts.net',
  enabled: true,
  saved: [
    { url: 'https://a.ts.net' },
    { url: 'https://b.ts.net' },
  ],
}

function makeDeps(cfg: ServerConfig | null): ServerSwitchDeps & {
  writeServerConfig: ReturnType<typeof vi.fn>
  probeServer: ReturnType<typeof vi.fn>
} {
  return {
    readServerConfig: vi.fn().mockResolvedValue(cfg),
    writeServerConfig: vi.fn().mockResolvedValue(undefined),
    // A minimal copy of withServerSelected's contract.
    select: (existing, url) => ({
      url,
      enabled: true,
      saved: [{ url }, ...(existing?.saved ?? []).filter((s) => s.url !== url)],
      ...(existing?.driver ? { driver: existing.driver } : {}),
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
    expect(await getServerTargets(makeDeps({ ...CFG, enabled: false }))).toEqual({
      current: null,
      saved: ['https://a.ts.net', 'https://b.ts.net'],
    })
  })

  it('reports nothing selected for the cleared-but-driver-kept config', async () => {
    const cleared: ServerConfig = {
      url: '', enabled: false, saved: [], driver: 'k8s',
    }
    expect(await getServerTargets(makeDeps(cleared))).toEqual({ current: null, saved: [] })
  })
})

describe('applyServerSwitch', () => {
  it('probes a saved server, then selects it', async () => {
    const deps = makeDeps({ ...CFG, enabled: false })
    expect(await applyServerSwitch({ url: 'https://b.ts.net' }, deps)).toEqual({ ok: true })
    expect(deps.probeServer).toHaveBeenCalledWith('https://b.ts.net')
    const written = deps.writeServerConfig.mock.calls[0][0] as ServerConfig
    expect(written).toMatchObject({ url: 'https://b.ts.net', enabled: true })
    expect(written.saved).toContainEqual({ url: 'https://a.ts.net' })
  })

  it('re-selecting the already-selected server is a real retry, not a no-op', async () => {
    // On the disconnected page this is the retry button.
    const deps = makeDeps(CFG)
    expect(await applyServerSwitch({ url: 'https://a.ts.net' }, deps)).toEqual({ ok: true })
    expect(deps.probeServer).toHaveBeenCalledWith('https://a.ts.net')
    expect(deps.writeServerConfig).toHaveBeenCalledTimes(1)
  })

  it('carries the install driver through a switch', async () => {
    const deps = makeDeps({ ...CFG, driver: 'k8s' })
    await applyServerSwitch({ url: 'https://b.ts.net' }, deps)
    expect(deps.writeServerConfig.mock.calls[0][0]).toMatchObject({ driver: 'k8s' })
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
      enabled: true,
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
