import { describe, it, expect, vi } from 'vitest'
import {
  addServerRemote,
  applyServerSwitch,
  getServerTargets,
  parseServerSelection,
  type ServerSwitchDeps,
} from '#server-switch'
import type { RemoteConfig } from '@yaac/shared/remote'

const CFG: RemoteConfig = {
  url: 'https://a.ts.net',
  token: 'ta',
  enabled: true,
  saved: [
    { url: 'https://a.ts.net', token: 'ta' },
    { url: 'https://b.ts.net', token: 'tb' },
  ],
}

function makeDeps(cfg: RemoteConfig | null): ServerSwitchDeps & {
  writeRemote: ReturnType<typeof vi.fn>
  probeRemote: ReturnType<typeof vi.fn>
} {
  return {
    readRemote: vi.fn().mockResolvedValue(cfg),
    writeRemote: vi.fn().mockResolvedValue(undefined),
    // The real withRemoteActivated is pure — use it verbatim via a thin copy
    // of its contract to keep assertions on what gets persisted.
    activate: (existing, url, token) => ({
      url,
      token,
      enabled: true,
      saved: [{ url, token }, ...(existing?.saved ?? []).filter((s) => s.url !== url)],
    }),
    probeRemote: vi.fn().mockResolvedValue({ buildId: 'b' }),
    normalizeUrl: (raw: string) => {
      const u = new URL(raw)
      if (u.pathname !== '/' || u.search || u.hash) throw new Error(`remote URL must be a bare origin (no path/query/fragment): ${raw}`)
      return u.origin
    },
  }
}

describe('parseServerSelection', () => {
  it('accepts the two selection shapes and rejects everything else', () => {
    expect(parseServerSelection({ kind: 'local' })).toEqual({ kind: 'local' })
    expect(parseServerSelection({ kind: 'remote', url: 'https://a.ts.net' }))
      .toEqual({ kind: 'remote', url: 'https://a.ts.net' })
    expect(parseServerSelection({ kind: 'remote' })).toBeNull()
    expect(parseServerSelection({ kind: 'other' })).toBeNull()
    expect(parseServerSelection('local')).toBeNull()
    expect(parseServerSelection(null)).toBeNull()
  })
})

describe('getServerTargets', () => {
  it('reports local with no saved remotes when nothing is configured', async () => {
    expect(await getServerTargets(makeDeps(null))).toEqual({ current: { kind: 'local' }, saved: [] })
  })

  it('reports the enabled remote as current and lists saved origins only', async () => {
    expect(await getServerTargets(makeDeps(CFG))).toEqual({
      current: { kind: 'remote', url: 'https://a.ts.net' },
      saved: ['https://a.ts.net', 'https://b.ts.net'],
    })
  })

  it('reports local when the configured remote is disabled', async () => {
    expect(await getServerTargets(makeDeps({ ...CFG, enabled: false })))
      .toMatchObject({ current: { kind: 'local' } })
  })
})

describe('applyServerSwitch', () => {
  it('switching to local disables the remote and keeps it saved', async () => {
    const deps = makeDeps(CFG)
    expect(await applyServerSwitch({ kind: 'local' }, deps)).toEqual({ ok: true, changed: true })
    expect(deps.writeRemote).toHaveBeenCalledWith({ ...CFG, enabled: false })
  })

  it('switching to the already-current target is a no-op', async () => {
    const localDeps = makeDeps(null)
    expect(await applyServerSwitch({ kind: 'local' }, localDeps)).toEqual({ ok: true, changed: false })
    expect(localDeps.writeRemote).not.toHaveBeenCalled()

    const remoteDeps = makeDeps(CFG)
    expect(await applyServerSwitch({ kind: 'remote', url: 'https://a.ts.net' }, remoteDeps))
      .toEqual({ ok: true, changed: false })
    expect(remoteDeps.probeRemote).not.toHaveBeenCalled()
  })

  it('switching to a saved remote probes with its saved token, then activates it', async () => {
    const deps = makeDeps({ ...CFG, enabled: false })
    expect(await applyServerSwitch({ kind: 'remote', url: 'https://b.ts.net' }, deps))
      .toEqual({ ok: true, changed: true })
    expect(deps.probeRemote).toHaveBeenCalledWith('https://b.ts.net', 'tb')
    const written = deps.writeRemote.mock.calls[0][0] as RemoteConfig
    expect(written).toMatchObject({ url: 'https://b.ts.net', token: 'tb', enabled: true })
    expect(written.saved).toContainEqual({ url: 'https://a.ts.net', token: 'ta' })
  })

  it('a failed probe surfaces its message and leaves the config untouched', async () => {
    const deps = makeDeps(CFG)
    deps.probeRemote.mockRejectedValue(new Error('cannot reach https://b.ts.net'))
    expect(await applyServerSwitch({ kind: 'remote', url: 'https://b.ts.net' }, deps))
      .toEqual({ ok: false, error: 'cannot reach https://b.ts.net' })
    expect(deps.writeRemote).not.toHaveBeenCalled()
  })

  it('an unknown remote url is rejected', async () => {
    const deps = makeDeps(CFG)
    expect(await applyServerSwitch({ kind: 'remote', url: 'https://nope.ts.net' }, deps))
      .toEqual({ ok: false, error: 'unknown remote: https://nope.ts.net' })
    expect(deps.writeRemote).not.toHaveBeenCalled()
  })
})

describe('addServerRemote', () => {
  it('normalizes, probes, and activates the new remote', async () => {
    const deps = makeDeps(CFG)
    expect(await addServerRemote('https://c.ts.net/', 'tc', deps)).toEqual({ ok: true, changed: true })
    expect(deps.probeRemote).toHaveBeenCalledWith('https://c.ts.net', 'tc')
    expect(deps.writeRemote).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://c.ts.net',
      token: 'tc',
      enabled: true,
    }))
  })

  it('rejects a non-origin URL before any probe', async () => {
    const deps = makeDeps(null)
    const outcome = await addServerRemote('https://c.ts.net/path', 'tc', deps)
    expect(outcome).toEqual({ ok: false, error: expect.stringMatching(/bare origin/) as string })
    expect(deps.probeRemote).not.toHaveBeenCalled()
  })

  it('a failed probe surfaces its message without persisting', async () => {
    const deps = makeDeps(null)
    deps.probeRemote.mockRejectedValue(new Error('token rejected by https://c.ts.net'))
    expect(await addServerRemote('https://c.ts.net', 'bad', deps))
      .toEqual({ ok: false, error: 'token rejected by https://c.ts.net' })
    expect(deps.writeRemote).not.toHaveBeenCalled()
  })
})
