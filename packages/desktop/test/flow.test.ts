import { describe, expect, it, vi } from 'vitest'
import type { ServerTarget } from '@yaac/shared/server-api'
import type { FlowDeps } from '#flow'
import { buildWebappUrl, runFlow } from '#flow'

const LOCAL: ServerTarget = { baseUrl: 'http://127.0.0.1:8787', secret: 's', remote: false }
const REMOTE: ServerTarget = { baseUrl: 'https://srv.ts.net', secret: 't', remote: true }

interface FakeOptions {
  resolve?: Array<ServerTarget | Error>
  start?: () => Promise<{ code: number | null, stderr: string }>
  ensure?: (target: ServerTarget) => Promise<void>
  mint?: () => Promise<string>
  rendererBaseUrl?: string
}

function fakeDeps(opts: FakeOptions = {}) {
  const resolutions = [...(opts.resolve ?? [LOCAL])]
  const statuses: string[] = []
  const start = vi.fn(opts.start ?? (() => Promise.resolve({ code: 0, stderr: '' })))
  const ensure = vi.fn(opts.ensure ?? (() => Promise.resolve()))
  const deps: FlowDeps = {
    resolveTarget: () => {
      const next = resolutions.shift()
      if (!next) return Promise.reject(new Error('yaac server is not running. Start it with: yaac server start'))
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
    },
    startLocalServer: start,
    ensureAuthDaemon: ensure,
    mintToken: opts.mint ?? (() => Promise.resolve('t0ken')),
    onStatus: (text) => {
      statuses.push(text)
    },
    rendererBaseUrl: opts.rendererBaseUrl,
  }
  return { deps, statuses, start, ensure }
}

describe('runFlow', () => {
  it('local happy path: resolve, ensure auth daemon, mint, url — no spawn', async () => {
    const { deps, statuses, start, ensure } = fakeDeps()
    expect(await runFlow(deps)).toEqual({ ok: true, url: `${LOCAL.baseUrl}/?token=t0ken` })
    expect(start).not.toHaveBeenCalled()
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure).toHaveBeenCalledWith(LOCAL)
    expect(statuses).toEqual([
      'Locating yaac server…',
      `Connecting to ${LOCAL.baseUrl}…`,
      `Opening ${LOCAL.baseUrl}…`,
    ])
  })
  it('server down: starts it, re-resolves, lands', async () => {
    const { deps, statuses, ensure } = fakeDeps({
      resolve: [new Error('yaac server is not running. Start it with: yaac server start'), LOCAL],
    })
    expect(await runFlow(deps)).toEqual({ ok: true, url: `${LOCAL.baseUrl}/?token=t0ken` })
    expect(statuses).toContain('Starting the local yaac server…')
    // Ensured against the re-resolved target, after the server came up.
    expect(ensure).toHaveBeenCalledWith(LOCAL)
  })
  it('a failed auth-daemon ensure never fails the flow', async () => {
    const { deps, ensure } = fakeDeps({
      ensure: () => Promise.reject(new Error('spawn yaac ENOENT')),
    })
    expect(await runFlow(deps)).toEqual({ ok: true, url: `${LOCAL.baseUrl}/?token=t0ken` })
    expect(ensure).toHaveBeenCalledTimes(1)
  })
  it('spawn failure → yaac-CLI-not-found error', async () => {
    const { deps, ensure } = fakeDeps({
      resolve: [new Error('not running')],
      start: () => Promise.reject(new Error('spawn yaac ENOENT')),
    })
    const result = await runFlow(deps)
    expect(result).toMatchObject({
      ok: false,
      error: { title: 'yaac CLI not found', detail: 'spawn yaac ENOENT' },
    })
    // No target ever resolved — nothing to point the auth daemon at.
    expect(ensure).not.toHaveBeenCalled()
  })
  it('non-zero exit → stderr surfaced verbatim', async () => {
    const { deps } = fakeDeps({
      resolve: [new Error('outdated')],
      start: () => Promise.resolve({ code: 1, stderr: 'Restart it with: yaac server restart' }),
    })
    const result = await runFlow(deps)
    expect(result).toMatchObject({
      ok: false,
      error: { title: 'yaac server failed to start', detail: 'Restart it with: yaac server restart' },
    })
  })
  it('started but still unresolvable → not-reachable error', async () => {
    const { deps, ensure } = fakeDeps({ resolve: [new Error('down'), new Error('still down')] })
    const result = await runFlow(deps)
    expect(result).toMatchObject({
      ok: false,
      error: { title: 'yaac server did not become reachable', detail: 'still down' },
    })
    expect(ensure).not.toHaveBeenCalled()
  })
  it('remote target: never spawns, mint failure gets remote-flavored error', async () => {
    const { deps, start } = fakeDeps({
      resolve: [REMOTE],
      mint: () => Promise.reject(new Error('remote server at https://srv.ts.net rejected the token')),
    })
    const result = await runFlow(deps)
    expect(result).toMatchObject({
      ok: false,
      error: {
        title: 'Could not connect to the remote server',
        detail: 'remote server at https://srv.ts.net rejected the token',
      },
    })
    expect(start).not.toHaveBeenCalled()
  })
  it('remote happy path: the auth daemon is ensured against the remote too', async () => {
    const { deps, ensure } = fakeDeps({ resolve: [REMOTE], mint: () => Promise.resolve('rem0te') })
    expect(await runFlow(deps)).toEqual({ ok: true, url: `${REMOTE.baseUrl}/?token=rem0te` })
    expect(ensure).toHaveBeenCalledWith(REMOTE)
  })
  it('rendererBaseUrl overrides the landing origin (Vite dev), not the target', async () => {
    const { deps, statuses } = fakeDeps({ rendererBaseUrl: 'http://localhost:1420/' })
    // The trailing slash is normalized away before /?token= is appended.
    expect(await runFlow(deps)).toEqual({ ok: true, url: 'http://localhost:1420/?token=t0ken' })
    // Mint still talked to the real target; only the final URL is overridden.
    expect(statuses).toContain(`Connecting to ${LOCAL.baseUrl}…`)
    expect(statuses).toContain('Opening http://localhost:1420…')
  })
  it('local mint failure → local-flavored error with restart hint', async () => {
    const { deps } = fakeDeps({ mint: () => Promise.reject(new Error('fetch failed')) })
    const result = await runFlow(deps)
    expect(result).toMatchObject({
      ok: false,
      error: { title: 'Could not connect to the yaac server', detail: 'fetch failed' },
    })
    if (!result.ok) expect(result.error.hint).toContain('yaac server restart')
  })
})

describe('buildWebappUrl', () => {
  it('appends the token query to the origin', () => {
    expect(buildWebappUrl('http://127.0.0.1:8787', 'abc123')).toBe('http://127.0.0.1:8787/?token=abc123')
  })
  it('escapes non-URL-safe tokens defensively', () => {
    expect(buildWebappUrl('https://srv.ts.net', 'a&b')).toBe('https://srv.ts.net/?token=a%26b')
  })
})
