import { describe, expect, it, vi } from 'vitest'
import type { ServerTarget } from '@yaac/shared/server-api'
import type { FlowDeps } from '#flow'
import { probeIdentity, runFlow } from '#flow'

const LOCAL: ServerTarget = { baseUrl: 'http://127.0.0.1:8787' }
const REMOTE: ServerTarget = { baseUrl: 'https://srv.ts.net' }

interface FakeOptions {
  resolve?: Array<ServerTarget | Error>
  ensure?: (target: ServerTarget) => Promise<void>
  probe?: () => Promise<unknown>
  rendererBaseUrl?: string
}

function fakeDeps(opts: FakeOptions = {}) {
  const resolutions = [...(opts.resolve ?? [LOCAL])]
  const statuses: string[] = []
  const ensure = vi.fn(opts.ensure ?? (() => Promise.resolve()))
  const deps: FlowDeps = {
    resolveTarget: () => {
      const next = resolutions.shift()
      if (!next) return Promise.reject(new Error('No yaac server selected.'))
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
    },
    ensureAuthDaemon: ensure,
    probeIdentity: opts.probe ?? (() => Promise.resolve({ kind: 'local' })),
    onStatus: (text) => {
      statuses.push(text)
    },
    rendererBaseUrl: opts.rendererBaseUrl,
  }
  return { deps, statuses, ensure }
}

describe('runFlow', () => {
  it('happy path: resolve, ensure auth daemon, identify, bare origin', async () => {
    const { deps, statuses, ensure } = fakeDeps()
    expect(await runFlow(deps)).toEqual({ ok: true, url: `${LOCAL.baseUrl}/` })
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure).toHaveBeenCalledWith(LOCAL)
    expect(statuses).toEqual([
      'Locating yaac server…',
      `Connecting to ${LOCAL.baseUrl}…`,
      `Opening ${LOCAL.baseUrl}…`,
    ])
  })

  it('a server elsewhere takes the identical path', async () => {
    // Nothing in the flow asks where a server runs: it is an origin either way.
    const { deps, ensure } = fakeDeps({
      resolve: [REMOTE],
      probe: () => Promise.resolve({ kind: 'tailnet', login: 'a@b', name: 'A' }),
    })
    expect(await runFlow(deps)).toEqual({ ok: true, url: `${REMOTE.baseUrl}/` })
    expect(ensure).toHaveBeenCalledWith(REMOTE)
  })

  it('nothing selected → the picker failure, with no server ever contacted', async () => {
    // The shell starts no server. The page this lands on is the fix, so the
    // hint sends the user there rather than to a terminal.
    const { deps, ensure } = fakeDeps({
      resolve: [new Error(
        'No yaac server selected.\n'
        + '    Start one on this machine with `yaac server start`,\n'
        + '    or point at one with `yaac remote set <url>`.',
      )],
    })
    const result = await runFlow(deps)
    expect(result).toMatchObject({
      ok: false,
      error: { title: 'No yaac server selected' },
    })
    if (result.ok) return
    // The heading is not repeated as the first line of the body, but the
    // commands the resolver names survive, un-indented.
    expect(result.error.detail).not.toMatch(/^No yaac server selected/)
    expect(result.error.detail).toMatch(/^Start one on this machine/)
    expect(result.error.detail).toContain('yaac remote set <url>')
    expect(result.error.hint).toMatch(/Pick a server below/)
    // Nothing resolved, so there is no target to point the daemon at.
    expect(ensure).not.toHaveBeenCalled()
  })

  it('keeps an unfamiliar resolver message whole', async () => {
    const { deps } = fakeDeps({ resolve: [new Error('something else entirely')] })
    const result = await runFlow(deps)
    if (result.ok) return
    expect(result.error.detail).toBe('something else entirely')
  })

  it('an unreachable server → its own failure, naming the origin', async () => {
    const { deps } = fakeDeps({
      probe: () => Promise.reject(new Error('cannot reach the yaac server at http://127.0.0.1:8787')),
    })
    const result = await runFlow(deps)
    expect(result).toMatchObject({
      ok: false,
      error: {
        title: 'Could not connect to http://127.0.0.1:8787',
        detail: 'cannot reach the yaac server at http://127.0.0.1:8787',
      },
    })
    // A server on THIS machine: the hint names the command that brings it
    // back, because the picker is now the whole window for that user.
    if (!result.ok) {
      expect(result.error.hint).toContain('yaac server start')
      expect(result.error.hint).toMatch(/pick a different server/)
    }
  })

  it('an unidentified device surfaces the server message verbatim', async () => {
    const refusal = 'tailscale serve sent no user identity: this device is a tagged device'
    const { deps } = fakeDeps({ resolve: [REMOTE], probe: () => Promise.reject(new Error(refusal)) })
    const result = await runFlow(deps)
    expect(result).toMatchObject({
      ok: false,
      error: { title: 'Could not connect to https://srv.ts.net', detail: refusal },
    })
    // Nothing to start for a server elsewhere, so no command is named.
    if (!result.ok) expect(result.error.hint).not.toContain('yaac server start')
  })

  it('a failed auth-daemon ensure never fails the flow', async () => {
    const { deps, ensure } = fakeDeps({
      ensure: () => Promise.reject(new Error('spawn yaac ENOENT')),
    })
    expect(await runFlow(deps)).toEqual({ ok: true, url: `${LOCAL.baseUrl}/` })
    expect(ensure).toHaveBeenCalledTimes(1)
  })

  it('rendererBaseUrl overrides the landing origin (Vite dev), not the target', async () => {
    const { deps, statuses } = fakeDeps({ rendererBaseUrl: 'http://localhost:1420/' })
    // The trailing slash is normalized, never doubled.
    expect(await runFlow(deps)).toEqual({ ok: true, url: 'http://localhost:1420/' })
    // The probe still talked to the real target; only the final URL is overridden.
    expect(statuses).toContain(`Connecting to ${LOCAL.baseUrl}…`)
    expect(statuses).toContain('Opening http://localhost:1420…')
  })
})

describe('probeIdentity', () => {
  function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })
  }

  it('asks /whoami with no credential and answers the principal', async () => {
    const seen: Array<{ url: string; auth: string | null }> = []
    const fetchImpl: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') })
      return Promise.resolve(json({ kind: 'local' }))
    }
    await expect(probeIdentity({ resolveTarget: () => Promise.resolve(LOCAL), fetchImpl }))
      .resolves.toEqual({ kind: 'local' })
    expect(seen).toEqual([{ url: `${LOCAL.baseUrl}/whoami`, auth: null }])
  })

  it("throws with the server's message when it will not identify this device", async () => {
    const fetchImpl: typeof globalThis.fetch = () => Promise.resolve(json(
      { error: { code: 'UNAUTHENTICATED', message: 'tailscale serve sent no user identity' } }, 401,
    ))
    await expect(probeIdentity({ resolveTarget: () => Promise.resolve(REMOTE), fetchImpl }))
      .rejects.toThrow('tailscale serve sent no user identity')
  })

  it('forces the build-skew warning off — the shell has no build identity', async () => {
    // With a build id injected and a remote target reporting a different
    // one, the shared client would warn on stderr; the shell must not
    // (it has no build identity — the id here belongs to no shell code).
    vi.stubEnv('YAAC_BUILD_ID', 'shell-build')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl: typeof globalThis.fetch = () =>
      Promise.resolve(json({ kind: 'local' }, 200, { 'x-yaac-build-id': 'server-build' }))
    await probeIdentity({ resolveTarget: () => Promise.resolve(REMOTE), fetchImpl })
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
    vi.unstubAllEnvs()
  })
})
