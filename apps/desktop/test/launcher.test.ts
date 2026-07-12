import { describe, expect, it, vi } from 'vitest'
import { SERVER_LOCK_FILENAME } from '@yaac/shared/server-lock-file'
import { REMOTE_CONFIG_FILENAME } from '@yaac/shared/remote-config-file'
import type { LauncherDeps } from '#deps'
import type { LauncherStatus } from '#status'
import { makeServerClient } from '#client'
import {
  buildWebappUrl,
  checkHealth,
  ensureLocalServer,
  mintWebToken,
  resolveTarget,
  runLauncher,
} from '#launcher'

const LOCK = { pid: 123, port: 8787, secret: 'lock-secret', startedAt: 1, buildId: 'b1' }
const LOCAL_ORIGIN = 'http://127.0.0.1:8787'
const REMOTE = { url: 'https://srv.ts.net', token: 'remote-token', enabled: true }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

type RouteHandler = (
  req: { url: URL, headers: Headers, body?: string },
) => Response | Promise<Response>

/**
 * fetch fake keyed on `${origin}${pathname}`; unrouted URLs reject like a
 * dead socket does.
 */
function httpFetch(handlers: Record<string, RouteHandler>): typeof globalThis.fetch {
  return (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw)
    const handler = handlers[`${url.origin}${url.pathname}`]
    if (!handler) return Promise.reject(new TypeError(`fetch failed: no route for ${url.href}`))
    return Promise.resolve(handler({
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    }))
  }
}

interface FakeOptions {
  files?: Record<string, string>
  fetchImpl?: typeof globalThis.fetch
  start?: () => Promise<{ code: number | null, stderr: string }>
}

function fakeDeps(opts: FakeOptions = {}) {
  const files = opts.files ?? {}
  const statuses: LauncherStatus[] = []
  const navigations: string[] = []
  const start = vi.fn(opts.start ?? (() => Promise.resolve({ code: 0, stderr: '' })))
  const deps: LauncherDeps = {
    readYaacFile: (name) => Promise.resolve(files[name] ?? null),
    fetch: opts.fetchImpl ?? (() => Promise.reject(new TypeError('fetch failed: network down'))),
    startLocalServer: start,
    navigate: (url) => {
      navigations.push(url)
    },
    sleep: () => Promise.resolve(),
    onStatus: (status) => {
      statuses.push(status)
    },
  }
  return { deps, files, statuses, navigations, start }
}

const healthOk: Record<string, RouteHandler> = {
  [`${LOCAL_ORIGIN}/health`]: () => json({ ok: true, buildId: 'b1' }),
}

describe('resolveTarget', () => {
  it('prefers an enabled remote', async () => {
    const { deps } = fakeDeps({
      files: {
        [REMOTE_CONFIG_FILENAME]: JSON.stringify(REMOTE),
        [SERVER_LOCK_FILENAME]: JSON.stringify(LOCK),
      },
    })
    expect(await resolveTarget(deps)).toEqual({
      baseUrl: REMOTE.url, secret: REMOTE.token, remote: true,
    })
  })
  it('falls through a disabled remote to the lock', async () => {
    const { deps } = fakeDeps({
      files: {
        [REMOTE_CONFIG_FILENAME]: JSON.stringify({ ...REMOTE, enabled: false }),
        [SERVER_LOCK_FILENAME]: JSON.stringify(LOCK),
      },
    })
    expect(await resolveTarget(deps)).toEqual({
      baseUrl: LOCAL_ORIGIN, secret: LOCK.secret, remote: false,
    })
  })
  it('falls through a malformed remote.json to the lock', async () => {
    const { deps } = fakeDeps({
      files: {
        [REMOTE_CONFIG_FILENAME]: 'not json',
        [SERVER_LOCK_FILENAME]: JSON.stringify(LOCK),
      },
    })
    expect((await resolveTarget(deps))?.baseUrl).toBe(LOCAL_ORIGIN)
  })
  it('returns null with no files or a malformed lock', async () => {
    expect(await resolveTarget(fakeDeps().deps)).toBeNull()
    const { deps } = fakeDeps({ files: { [SERVER_LOCK_FILENAME]: '{"port":1}' } })
    expect(await resolveTarget(deps)).toBeNull()
  })
})

describe('checkHealth', () => {
  const target = { baseUrl: LOCAL_ORIGIN, secret: 's', remote: false }
  it('true on 200', async () => {
    const client = makeServerClient(httpFetch(healthOk), target)
    expect(await checkHealth(client)).toBe(true)
  })
  it('false on non-2xx', async () => {
    const client = makeServerClient(
      httpFetch({ [`${LOCAL_ORIGIN}/health`]: () => new Response(null, { status: 503 }) }),
      target,
    )
    expect(await checkHealth(client)).toBe(false)
  })
  it('false when fetch rejects', async () => {
    const client = makeServerClient(httpFetch({}), target)
    expect(await checkHealth(client)).toBe(false)
  })
})

describe('ensureLocalServer', () => {
  it('short-circuits on a live existing target without spawning', async () => {
    const { deps, start } = fakeDeps({ fetchImpl: httpFetch(healthOk) })
    const existing = { baseUrl: LOCAL_ORIGIN, secret: LOCK.secret, remote: false }
    expect(await ensureLocalServer(deps, existing)).toEqual({ ok: true, target: existing })
    expect(start).not.toHaveBeenCalled()
  })
  it('maps a spawn failure to no-cli', async () => {
    const { deps } = fakeDeps({
      start: () => Promise.reject(new Error('program not found')),
    })
    expect(await ensureLocalServer(deps, null)).toEqual({
      ok: false, kind: 'no-cli', detail: 'program not found',
    })
  })
  it('surfaces a non-zero exit as server-start-failed with stderr verbatim', async () => {
    const { deps } = fakeDeps({
      start: () => Promise.resolve({ code: 1, stderr: 'Restart it with: yaac server restart' }),
    })
    expect(await ensureLocalServer(deps, null)).toEqual({
      ok: false, kind: 'server-start-failed', detail: 'Restart it with: yaac server restart',
    })
  })
  it('polls until the spawned server writes a live lock', async () => {
    const files: Record<string, string> = {}
    const { deps } = fakeDeps({
      files,
      fetchImpl: httpFetch(healthOk),
      start: () => {
        files[SERVER_LOCK_FILENAME] = JSON.stringify(LOCK)
        return Promise.resolve({ code: 0, stderr: '' })
      },
    })
    const result = await ensureLocalServer(deps, null)
    expect(result).toEqual({
      ok: true, target: { baseUrl: LOCAL_ORIGIN, secret: LOCK.secret, remote: false },
    })
  })
  it('gives up as no-server when the lock never appears', async () => {
    const sleeps: number[] = []
    const { deps } = fakeDeps()
    deps.sleep = (ms) => {
      sleeps.push(ms)
      return Promise.resolve()
    }
    expect(await ensureLocalServer(deps, null)).toEqual({ ok: false, kind: 'no-server' })
    expect(sleeps.length).toBeGreaterThan(0)
  })
})

describe('mintWebToken', () => {
  const target = { baseUrl: LOCAL_ORIGIN, secret: LOCK.secret, remote: false }
  it('returns the token and sends the bearer and one-time body', async () => {
    let seenAuth: string | null = null
    let seenBody: string | undefined
    const client = makeServerClient(httpFetch({
      [`${LOCAL_ORIGIN}/tokens`]: ({ headers, body }) => {
        seenAuth = headers.get('authorization')
        seenBody = body
        return json({ name: 'web-1', token: 't0ken', kind: 'one-time' }, 201)
      },
    }), target)
    expect(await mintWebToken(client)).toEqual({ ok: true, token: 't0ken' })
    expect(seenAuth).toBe(`Bearer ${LOCK.secret}`)
    expect(JSON.parse(seenBody ?? '{}')).toEqual({ kind: 'one-time' })
  })
  it('maps non-2xx to its status', async () => {
    const client = makeServerClient(httpFetch({
      [`${LOCAL_ORIGIN}/tokens`]: () => json({ error: {} }, 401),
    }), target)
    expect(await mintWebToken(client)).toMatchObject({ ok: false, status: 401 })
  })
  it('maps a network error to status 0', async () => {
    const client = makeServerClient(httpFetch({}), target)
    expect(await mintWebToken(client)).toMatchObject({ ok: false, status: 0 })
  })
})

describe('buildWebappUrl', () => {
  it('appends the token query to the origin', () => {
    expect(buildWebappUrl(LOCAL_ORIGIN, 'abc123')).toBe(`${LOCAL_ORIGIN}/?token=abc123`)
  })
  it('escapes non-URL-safe tokens defensively', () => {
    expect(buildWebappUrl('https://srv.ts.net', 'a&b')).toBe('https://srv.ts.net/?token=a%26b')
  })
})

describe('runLauncher', () => {
  it('remote happy path: health, token, navigate', async () => {
    const { deps, navigations, statuses } = fakeDeps({
      files: { [REMOTE_CONFIG_FILENAME]: JSON.stringify(REMOTE) },
      fetchImpl: httpFetch({
        [`${REMOTE.url}/health`]: () => json({ ok: true, buildId: 'b2' }),
        [`${REMOTE.url}/tokens`]: () => json({ name: 'web-1', token: 'rem0te', kind: 'one-time' }, 201),
      }),
    })
    await runLauncher(deps)
    expect(navigations).toEqual([`${REMOTE.url}/?token=rem0te`])
    expect(statuses.map((s) => s.phase)).toEqual(['resolving', 'connecting', 'navigating'])
  })
  it('remote unreachable → unreachable-remote, never spawns', async () => {
    const { deps, start, statuses, navigations } = fakeDeps({
      files: { [REMOTE_CONFIG_FILENAME]: JSON.stringify(REMOTE) },
    })
    await runLauncher(deps)
    expect(statuses.at(-1)).toEqual({
      phase: 'error', kind: 'unreachable-remote', detail: REMOTE.url,
    })
    expect(start).not.toHaveBeenCalled()
    expect(navigations).toEqual([])
  })
  it('remote 401 → bad-token', async () => {
    const { deps, statuses } = fakeDeps({
      files: { [REMOTE_CONFIG_FILENAME]: JSON.stringify(REMOTE) },
      fetchImpl: httpFetch({
        [`${REMOTE.url}/health`]: () => json({ ok: true, buildId: 'b2' }),
        [`${REMOTE.url}/tokens`]: () => json({ error: {} }, 401),
      }),
    })
    await runLauncher(deps)
    expect(statuses.at(-1)).toEqual({ phase: 'error', kind: 'bad-token', detail: REMOTE.url })
  })
  it('local happy path with a live lock', async () => {
    const { deps, navigations, start } = fakeDeps({
      files: { [SERVER_LOCK_FILENAME]: JSON.stringify(LOCK) },
      fetchImpl: httpFetch({
        ...healthOk,
        [`${LOCAL_ORIGIN}/tokens`]: () => json({ name: 'web-1', token: 'l0cal', kind: 'one-time' }, 201),
      }),
    })
    await runLauncher(deps)
    expect(navigations).toEqual([`${LOCAL_ORIGIN}/?token=l0cal`])
    expect(start).not.toHaveBeenCalled()
  })
  it('local stale lock: 401 re-resolves the rotated lock and retries once', async () => {
    const newLock = { ...LOCK, port: 8788, secret: 'new-secret' }
    const newOrigin = 'http://127.0.0.1:8788'
    const { deps, files, navigations } = fakeDeps({
      files: { [SERVER_LOCK_FILENAME]: JSON.stringify(LOCK) },
    })
    deps.fetch = httpFetch({
      ...healthOk,
      [`${LOCAL_ORIGIN}/tokens`]: () => {
        // The restart that invalidated our secret also rewrote the lock.
        files[SERVER_LOCK_FILENAME] = JSON.stringify(newLock)
        return json({ error: {} }, 401)
      },
      [`${newOrigin}/tokens`]: ({ headers }) =>
        headers.get('authorization') === `Bearer ${newLock.secret}`
          ? json({ name: 'web-2', token: 'fresh', kind: 'one-time' }, 201)
          : json({ error: {} }, 401),
    })
    await runLauncher(deps)
    expect(navigations).toEqual([`${newOrigin}/?token=fresh`])
  })
  it('local ensure failure propagates as an error status', async () => {
    const { deps, statuses, navigations } = fakeDeps({
      start: () => Promise.reject(new Error('spawn yaac ENOENT')),
    })
    await runLauncher(deps)
    expect(statuses.at(-1)).toEqual({
      phase: 'error', kind: 'no-cli', detail: 'spawn yaac ENOENT',
    })
    expect(navigations).toEqual([])
  })
})
