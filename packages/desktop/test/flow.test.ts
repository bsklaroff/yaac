import { describe, expect, it, vi } from 'vitest'
import type { ServerTarget } from '@yaac/shared/server-api'
import type { FlowDeps } from '#flow'
import { buildWebappUrl, runFlow } from '#flow'

const LOCAL: ServerTarget = { baseUrl: 'http://127.0.0.1:8787', secret: 's' }
const REMOTE: ServerTarget = { baseUrl: 'https://srv.ts.net', secret: 't' }

interface FakeOptions {
  resolve?: Array<ServerTarget | Error>
  ensure?: (target: ServerTarget) => Promise<void>
  mint?: () => Promise<string>
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
    mintToken: opts.mint ?? (() => Promise.resolve('t0ken')),
    onStatus: (text) => {
      statuses.push(text)
    },
    rendererBaseUrl: opts.rendererBaseUrl,
  }
  return { deps, statuses, ensure }
}

describe('runFlow', () => {
  it('happy path: resolve, ensure auth daemon, mint, url', async () => {
    const { deps, statuses, ensure } = fakeDeps()
    expect(await runFlow(deps)).toEqual({ ok: true, url: `${LOCAL.baseUrl}/?token=t0ken` })
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure).toHaveBeenCalledWith(LOCAL)
    expect(statuses).toEqual([
      'Locating yaac server…',
      `Connecting to ${LOCAL.baseUrl}…`,
      `Opening ${LOCAL.baseUrl}…`,
    ])
  })

  it('a server elsewhere takes the identical path', async () => {
    // Nothing in the flow asks where a server runs: it is an origin and a
    // token either way.
    const { deps, ensure } = fakeDeps({ resolve: [REMOTE], mint: () => Promise.resolve('rem0te') })
    expect(await runFlow(deps)).toEqual({ ok: true, url: `${REMOTE.baseUrl}/?token=rem0te` })
    expect(ensure).toHaveBeenCalledWith(REMOTE)
  })

  it('nothing selected → the picker failure, with no server ever contacted', async () => {
    // The shell starts no server. The page this lands on is the fix, so the
    // hint sends the user there rather than to a terminal.
    const { deps, ensure } = fakeDeps({
      resolve: [new Error(
        'No yaac server selected.\n'
        + '    Start one on this machine with `yaac server start`,\n'
        + '    or point at one with `yaac remote set <url> --token <token>`.',
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
    expect(result.error.detail).toContain('yaac remote set <url> --token <token>')
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
      mint: () => Promise.reject(new Error('cannot reach the yaac server at http://127.0.0.1:8787')),
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

  it('a rejected token surfaces the client message verbatim', async () => {
    const { deps } = fakeDeps({
      resolve: [REMOTE],
      mint: () => Promise.reject(new Error('the yaac server at https://srv.ts.net rejected the token.')),
    })
    const result = await runFlow(deps)
    expect(result).toMatchObject({
      ok: false,
      error: {
        title: 'Could not connect to https://srv.ts.net',
        detail: 'the yaac server at https://srv.ts.net rejected the token.',
      },
    })
    // Nothing to start for a server elsewhere, so no command is named.
    if (!result.ok) expect(result.error.hint).not.toContain('yaac server start')
  })

  it('a failed auth-daemon ensure never fails the flow', async () => {
    const { deps, ensure } = fakeDeps({
      ensure: () => Promise.reject(new Error('spawn yaac ENOENT')),
    })
    expect(await runFlow(deps)).toEqual({ ok: true, url: `${LOCAL.baseUrl}/?token=t0ken` })
    expect(ensure).toHaveBeenCalledTimes(1)
  })

  it('rendererBaseUrl overrides the landing origin (Vite dev), not the target', async () => {
    const { deps, statuses } = fakeDeps({ rendererBaseUrl: 'http://localhost:1420/' })
    // The trailing slash is normalized away before /?token= is appended.
    expect(await runFlow(deps)).toEqual({ ok: true, url: 'http://localhost:1420/?token=t0ken' })
    // Mint still talked to the real target; only the final URL is overridden.
    expect(statuses).toContain(`Connecting to ${LOCAL.baseUrl}…`)
    expect(statuses).toContain('Opening http://localhost:1420…')
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
