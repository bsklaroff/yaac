/**
 * `createForwardSet`, the reconciler both resident forwarders share.
 * `startForward` is stubbed (port-tunnel.test.ts covers it); these tests
 * check which forwards start, stay, and close as the desired set changes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const startForward = vi.hoisted(() => vi.fn())
const startHostRouter = vi.hoisted(() => vi.fn())
vi.mock('#port-tunnel', () => ({ startForward, startHostRouter }))

import { createForwardSet, serverNeedsForwarder, snapshotForwards } from '#port-tunnel-set'
import type { ForwardSpec } from '#port-tunnel'
import type { ServerSnapshot } from '#types'

const TARGET = { baseUrl: 'http://127.0.0.1:8787' }

function spec(session: string, containerPort: number, hostPort = containerPort): ForwardSpec {
  return { session, containerPort, hostPort }
}

/** A live forward holding its own host port. */
function up(s: ForwardSpec, localPort = s.hostPort): ForwardSpec & { localPort: number } {
  return { ...s, localPort }
}

function inUse(): Error {
  return Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
}

/** Every handle handed out, so a test can see which were closed. */
let handles: Array<{ spec: ForwardSpec; close: ReturnType<typeof vi.fn> }>

beforeEach(() => {
  handles = []
  startForward.mockReset()
  startForward.mockImplementation((_t: unknown, s: ForwardSpec) => {
    const close = vi.fn()
    handles.push({ spec: s, close })
    return Promise.resolve({ hostPort: s.hostPort, close })
  })
})

describe('createForwardSet', () => {
  it('starts what is new and leaves an unchanged forward alone', async () => {
    // A workspace gaining a port must not close the others' connections.
    const set = createForwardSet(TARGET)
    await set.reconcile([spec('a', 3000)])
    await set.reconcile([spec('a', 3000), spec('b', 5173)])

    expect(startForward).toHaveBeenCalledTimes(2)
    expect(handles[0].close).not.toHaveBeenCalled()
    expect(set.live()).toEqual([up(spec('a', 3000)), up(spec('b', 5173))])
  })

  it('drops a forward the server no longer offers', async () => {
    const set = createForwardSet(TARGET)
    await set.reconcile([spec('a', 3000), spec('b', 5173)])
    await set.reconcile([spec('a', 3000)])

    expect(handles[1].close).toHaveBeenCalledTimes(1)
    expect(set.live()).toEqual([up(spec('a', 3000))])
  })

  it('treats a moved host port as a different forward', async () => {
    // The old listener must close, or it would keep serving the previous
    // mapping.
    const set = createForwardSet(TARGET)
    await set.reconcile([spec('a', 3000, 3000)])
    await set.reconcile([spec('a', 3000, 3001)])

    expect(handles[0].close).toHaveBeenCalledTimes(1)
    expect(set.live()).toEqual([up(spec('a', 3000, 3001))])
  })

  it('reports a forward that cannot bind and brings the rest up anyway', async () => {
    // Another process holds the port; the other forwards must still start.
    startForward.mockImplementationOnce(() => Promise.reject(new Error('EADDRINUSE')))
    const failures: Array<[number, string]> = []
    const set = createForwardSet(TARGET, {
      onBindError: (s, m) => failures.push([s.hostPort, m]),
    })

    await set.reconcile([spec('a', 3000), spec('b', 5173)])

    expect(failures).toEqual([[3000, 'EADDRINUSE']])
    expect(set.live()).toEqual([up(spec('b', 5173))])
  })

  it('retries a failed bind on the next reconcile', async () => {
    startForward.mockImplementationOnce(() => Promise.reject(new Error('EADDRINUSE')))
    const set = createForwardSet(TARGET)

    await set.reconcile([spec('a', 3000)])
    expect(set.live()).toEqual([])
    await set.reconcile([spec('a', 3000)])

    expect(set.live()).toEqual([up(spec('a', 3000))])
  })

  it('announces each forward coming up and going away', async () => {
    const events: string[] = []
    const set = createForwardSet(TARGET, {
      onChange: (f, state) => events.push(`${state} ${String(f.localPort)}`),
    })

    await set.reconcile([spec('a', 3000)])
    await set.reconcile([])

    expect(events).toEqual(['up 3000', 'down 3000'])
  })

  it('closes everything, and stays closed', async () => {
    // Quitting leaves no listener, even with a reconcile racing the quit.
    const set = createForwardSet(TARGET)
    await set.reconcile([spec('a', 3000)])

    set.close()
    await set.reconcile([spec('a', 3000), spec('b', 5173)])

    expect(handles[0].close).toHaveBeenCalledTimes(1)
    expect(set.live()).toEqual([])
    expect(startForward).toHaveBeenCalledTimes(1)
  })

  it('falls back to the next free port the other forwards do not ask for', async () => {
    // Something else holds 3000 and 3001; 3002 belongs to another forward.
    const taken = new Set([3000, 3001])
    startForward.mockImplementation((_t: unknown, s: ForwardSpec) => {
      if (taken.has(s.hostPort)) return Promise.reject(inUse())
      return Promise.resolve({ hostPort: s.hostPort, close: vi.fn() })
    })
    const events: string[] = []
    const set = createForwardSet(TARGET, {
      fallback: true,
      onChange: (f, state) => events.push(`${state} ${String(f.hostPort)}@${String(f.localPort)}`),
    })

    await set.reconcile([spec('a', 3000), spec('b', 3002)])

    expect(set.live()).toEqual([up(spec('a', 3000), 3003), up(spec('b', 3002))])
    expect(events).toEqual(['up 3000@3003', 'up 3002@3002'])
  })

  it('keeps a fallback port after the original frees up, and binds a strict set only as named', async () => {
    const taken = new Set([3000])
    startForward.mockImplementation((_t: unknown, s: ForwardSpec) =>
      taken.has(s.hostPort) ? Promise.reject(inUse()) : Promise.resolve({ hostPort: s.hostPort, close: vi.fn() }))
    const failures: string[] = []
    const strict = createForwardSet(TARGET, { onBindError: (_s, m) => failures.push(m) })
    await strict.reconcile([spec('a', 3000)])
    expect(strict.live()).toEqual([])
    expect(failures).toEqual(['listen EADDRINUSE'])

    startForward.mockClear()
    const set = createForwardSet(TARGET, { fallback: true })
    await set.reconcile([spec('a', 3000)])
    // The open page's URL must not move when 3000 frees up.
    taken.clear()
    await set.reconcile([spec('a', 3000)])
    expect(set.live()).toEqual([up(spec('a', 3000), 3001)])
    // The taken port, then its fallback; the second reconcile binds nothing.
    expect(startForward).toHaveBeenCalledTimes(2)
  })

  it('never tries a port the set already holds as a fallback', async () => {
    // Model the OS: a port this set already listens on is taken too.
    const held = new Set([3000])
    startForward.mockImplementation((_t: unknown, s: ForwardSpec) => {
      if (held.has(s.hostPort)) return Promise.reject(inUse())
      held.add(s.hostPort)
      return Promise.resolve({ hostPort: s.hostPort, close: vi.fn() })
    })
    const set = createForwardSet(TARGET, { fallback: true })
    await set.reconcile([spec('a', 3000)])
    // Both scan past `a`'s fallback from the earlier pass, and `c` past
    // `b`'s from this one.
    await set.reconcile([spec('a', 3000), spec('b', 3000), spec('c', 3000)])

    expect(set.live()).toEqual([
      up(spec('a', 3000), 3001), up(spec('b', 3000), 3002), up(spec('c', 3000), 3003),
    ])
    expect(startForward.mock.calls.map(([, s]) => (s as ForwardSpec).hostPort))
      .toEqual([3000, 3001, 3000, 3002, 3000, 3003])
  })

  it('gives up after a bounded run of taken ports, and on any other bind error', async () => {
    startForward.mockImplementation(() => Promise.reject(inUse()))
    const failures: string[] = []
    const set = createForwardSet(TARGET, { fallback: true, onBindError: (_s, m) => failures.push(m) })
    await set.reconcile([spec('a', 3000)])
    expect(failures).toEqual(['no free port in 3000–3100'])

    startForward.mockReset()
    startForward.mockImplementation(() => Promise.reject(new Error('EADDRNOTAVAIL')))
    await set.reconcile([spec('a', 3000)])
    expect(startForward).toHaveBeenCalledTimes(1)
    expect(set.live()).toEqual([])
  })

  it('binds one hostname router, past a taken port, routing to what was last offered', async () => {
    const taken = new Set([8786])
    let route!: (name: { port: number; idPrefix: string }) => ForwardSpec | undefined
    const routerClose = vi.fn()
    startHostRouter.mockImplementation((_t: unknown, port: number, resolve: typeof route) => {
      if (taken.has(port)) return Promise.reject(inUse())
      route = resolve
      return Promise.resolve({ hostPort: port, close: routerClose })
    })
    const bound: number[] = []
    const set = createForwardSet(TARGET, { hostsPort: 8786, onHostsBound: (p) => bound.push(p) })
    const a = spec('ab12cd34-0000', 3000)
    await set.reconcile([a])
    await set.reconcile([a, spec('ffff0000-0000', 3000, 3001)])

    expect(startHostRouter).toHaveBeenCalledTimes(2)
    expect(bound).toEqual([8787])
    expect(set.hostsPort()).toBe(8787)
    expect(route({ port: 3000, idPrefix: 'ab12cd34' })).toEqual(a)
    expect(route({ port: 3000, idPrefix: 'ffff0000' })?.hostPort).toBe(3001)
    expect(route({ port: 5173, idPrefix: 'ab12cd34' })).toBeUndefined()
    // A prefix two workspaces share names neither, whichever port it asks for.
    await set.reconcile([a, spec('ab12cd34-1111', 5173)])
    expect(route({ port: 3000, idPrefix: 'ab12cd34' })).toBeUndefined()
    expect(route({ port: 5173, idPrefix: 'ab12cd34' })).toBeUndefined()
    // A port the server stops offering stops routing with its forward.
    await set.reconcile([])
    expect(route({ port: 3000, idPrefix: 'ab12cd34' })).toBeUndefined()

    set.close()
    expect(routerClose).toHaveBeenCalledTimes(1)
    expect(set.hostsPort()).toBeUndefined()
  })

  it('runs overlapping reconciles one at a time, so a new port is bound once', async () => {
    const set = createForwardSet(TARGET)
    await Promise.all([set.reconcile([spec('a', 3000)]), set.reconcile([spec('a', 3000)])])
    expect(startForward).toHaveBeenCalledTimes(1)
  })
})

describe('serverNeedsForwarder', () => {
  it('always binds against a k8s server, wherever it is', () => {
    // A forward works only while a client holds its listener, even for a
    // local origin.
    expect(serverNeedsForwarder('k8s', 'http://127.0.0.1:8787')).toBe(true)
    expect(serverNeedsForwarder('k8s', 'https://srv.ts.net')).toBe(true)
  })

  it('never binds against a containerless server on this machine', () => {
    // Dev servers already hold these ports on this machine.
    for (const origin of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787']) {
      expect(serverNeedsForwarder('containerless', origin)).toBe(false)
    }
  })

  it('binds against a remote containerless server, whose ports are as far away as a pod\'s', () => {
    expect(serverNeedsForwarder('containerless', 'https://srv.ts.net')).toBe(true)
    expect(serverNeedsForwarder('containerless', 'http://10.0.0.7:8787')).toBe(true)
  })
})

describe('snapshotForwards', () => {
  const snapshot = {
    driver: 'k8s',
    workspaces: [
      { workspaceId: 'a', forwardedPorts: [{ containerPort: 3000, hostPort: 3000 }, { containerPort: 5432, hostPort: 15432 }] },
      { workspaceId: 'b', forwardedPorts: [{ containerPort: 3000, hostPort: 3001 }] },
      { workspaceId: 'c', forwardedPorts: [] },
    ],
  } as unknown as ServerSnapshot

  it('flattens every workspace\'s offered mappings into one desired set', () => {
    expect(snapshotForwards(snapshot)).toEqual([
      { session: 'a', containerPort: 3000, hostPort: 3000 },
      { session: 'a', containerPort: 5432, hostPort: 15432 },
      { session: 'b', containerPort: 3000, hostPort: 3001 },
    ])
  })

  it('keeps only the named workspace\'s', () => {
    expect(snapshotForwards(snapshot, 'b')).toEqual([
      { session: 'b', containerPort: 3000, hostPort: 3001 },
    ])
  })
})
