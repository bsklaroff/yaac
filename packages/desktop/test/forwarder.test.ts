/**
 * The desktop forwarder's wiring, and the preview panes' proxies. The
 * reconciler and the SOCKS5 listener themselves are tested in `@yaac/shared`.
 */
import net from 'node:net'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPreviewProxies, startForwarder } from '#forwarder'
import type { ForwardSpec } from '@yaac/shared/port-tunnel'
import type { ServerTarget } from '@yaac/shared/server-api'
import type { ServerSnapshot, WorkspaceListEntry } from '@yaac/shared/types'

const LOCAL: ServerTarget = { baseUrl: 'http://127.0.0.1:8787' }
const OTHER: ServerTarget = { baseUrl: 'https://srv.ts.net' }

function workspace(workspaceId: string, ports: Array<[number, number]>): WorkspaceListEntry {
  return {
    workspaceId,
    projectId: 'proj',
    tool: 'claude',
    mode: 'tui',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    jobName: `yaac-proj-${workspaceId}`,
    conversations: [],
    blockedHosts: [],
    unforwardedPorts: [],
    forwardedPorts: ports.map(([containerPort, hostPort]) => ({ containerPort, hostPort })),
  } as unknown as WorkspaceListEntry
}

function snapshot(
  workspaces: WorkspaceListEntry[],
  driver: ServerSnapshot['driver'] = 'k8s',
): ServerSnapshot {
  return { driver, workspaces } as unknown as ServerSnapshot
}

/** A fake reconciler that records every desired set it is handed. */
function fakeSet(): {
  create: ReturnType<typeof vi.fn>
  reconciled: ForwardSpec[][]
  closes: number
  targets: string[]
} {
  const state = {
    create: vi.fn(),
    reconciled: [] as ForwardSpec[][],
    closes: 0,
    targets: [] as string[],
  }
  state.create.mockImplementation((target: { baseUrl: string }) => {
    state.targets.push(target.baseUrl)
    return {
      reconcile: (specs: ForwardSpec[]) => {
        state.reconciled.push(specs)
        return Promise.resolve()
      },
      close: () => { state.closes += 1 },
    }
  })
  return state
}

/** Let the forwarder's serialized reconcile chain drain. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

let set: ReturnType<typeof fakeSet>
let resolveTarget: ReturnType<typeof vi.fn<() => Promise<ServerTarget>>>

beforeEach(() => {
  set = fakeSet()
  resolveTarget = vi.fn<() => Promise<ServerTarget>>().mockResolvedValue(LOCAL)
})

describe('startForwarder', () => {
  it('reconciles the snapshot against the resolved server', async () => {
    const forwarder = startForwarder({ resolveTarget, createSet: set.create as never })

    forwarder.apply(snapshot([workspace('a', [[3000, 3000]])]))
    await settle()

    expect(set.targets).toEqual([LOCAL.baseUrl])
    expect(set.reconciled).toEqual([[{ session: 'a', containerPort: 3000, hostPort: 3000 }]])
  })

  it('coalesces a burst of snapshots down to the newest', async () => {
    // Replaying every snapshot would needlessly unbind and rebind ports.
    const forwarder = startForwarder({ resolveTarget, createSet: set.create as never })

    forwarder.apply(snapshot([workspace('a', [[3000, 3000]])]))
    forwarder.apply(snapshot([workspace('a', [[3001, 3001]])]))
    forwarder.apply(snapshot([workspace('a', [[3002, 3002]])]))
    await settle()

    expect(set.reconciled).toEqual([[{ session: 'a', containerPort: 3002, hostPort: 3002 }]])
  })

  it('rebuilds against a switched server rather than reconciling onto it', async () => {
    const forwarder = startForwarder({ resolveTarget, createSet: set.create as never })
    forwarder.apply(snapshot([workspace('a', [[3000, 3000]])]))
    await settle()

    resolveTarget.mockResolvedValue(OTHER)
    forwarder.apply(snapshot([workspace('a', [[3000, 3000]])]))
    await settle()

    expect(set.targets).toEqual([LOCAL.baseUrl, OTHER.baseUrl])
    expect(set.closes).toBe(1)
  })

  it('binds nothing against a containerless server on this machine', async () => {
    // The workspace processes already hold these ports on this machine
    // (docs/port-forward-tunnel.md).
    const f = startForwarder({ resolveTarget, createSet: set.create as never })
    f.apply(snapshot([workspace('a', [[3000, 3000]])], 'containerless'))
    await settle()
    expect(set.reconciled).toEqual([[]])
    f.stop()
  })

  it('decides what to bind from the origin it resolved, not the page', async () => {
    resolveTarget.mockResolvedValue(OTHER)
    const f = startForwarder({ resolveTarget, createSet: set.create as never })
    f.apply(snapshot([workspace('a', [[3000, 3000]])], 'containerless'))
    await settle()
    expect(set.reconciled).toEqual([[{ session: 'a', containerPort: 3000, hostPort: 3000 }]])
    f.stop()
  })

  it('reuses the set while the server is unchanged', async () => {
    const forwarder = startForwarder({ resolveTarget, createSet: set.create as never })
    forwarder.apply(snapshot([workspace('a', [[3000, 3000]])]))
    await settle()
    forwarder.apply(snapshot([workspace('a', [[3000, 3000]])]))
    await settle()

    expect(set.create).toHaveBeenCalledTimes(1)
  })

  it('says so and carries on when the target cannot be resolved', async () => {
    // The next snapshot resolves the target again.
    resolveTarget.mockRejectedValueOnce(new Error('yaac server is not running'))
    const said: string[] = []
    const forwarder = startForwarder({
      resolveTarget,
      createSet: set.create as never,
      onMessage: (t) => said.push(t),
    })

    forwarder.apply(snapshot([workspace('a', [[3000, 3000]])]))
    await settle()
    expect(said.join(' ')).toContain('yaac server is not running')

    forwarder.apply(snapshot([workspace('a', [[3000, 3000]])]))
    await settle()
    expect(set.reconciled).toHaveLength(1)
  })

  it('routes workspace hostnames only for a remote server, and tells the page where', async () => {
    // A server on this machine routes them on its own port.
    const published: Array<number | null> = []
    const forwarder = startForwarder({
      resolveTarget,
      createSet: set.create as never,
      onHostsPort: (p) => published.push(p),
    })
    forwarder.apply(snapshot([]))
    await settle()
    const optsOf = (i: number): { hostsPort?: number; onHostsBound: (p: number) => void } =>
      set.create.mock.calls[i][1] as never
    expect(optsOf(0).hostsPort).toBeUndefined()

    resolveTarget.mockResolvedValue(OTHER)
    forwarder.apply(snapshot([]))
    await settle()
    expect(optsOf(1).hostsPort).toBe(8786)
    optsOf(1).onHostsBound(8787)
    expect(forwarder.hostsPort()).toBe(8787)

    // A switch away, and a stop, take it back from the page.
    resolveTarget.mockResolvedValue(LOCAL)
    forwarder.apply(snapshot([]))
    await settle()
    expect(forwarder.hostsPort()).toBeNull()
    forwarder.stop()
    expect(published).toEqual([8787, null])
  })

  it('routes a preview connection to a port the latest snapshot offers, once there is one', async () => {
    // A pane may connect before the app's own first snapshot lands.
    const forwarder = startForwarder({ resolveTarget, createSet: set.create as never })
    const early = forwarder.route('a', 3000)
    forwarder.apply(snapshot([workspace('a', [[3000, 3000]]), workspace('b', [[4000, 4000]])], 'containerless'))

    // Under containerless on this machine too, where nothing is bound.
    const offered = { target: { baseUrl: LOCAL.baseUrl }, spec: { session: 'a', containerPort: 3000, hostPort: 3000 } }
    expect(await early).toEqual(offered)
    expect(await forwarder.route('a', 4000)).toBeUndefined()
    expect(await forwarder.route('c', 3000)).toBeUndefined()

    forwarder.stop()
    expect(await forwarder.route('a', 3000)).toBeUndefined()
  })

  it('lets every forward go on stop, and takes no more snapshots', async () => {
    const forwarder = startForwarder({ resolveTarget, createSet: set.create as never })
    forwarder.apply(snapshot([workspace('a', [[3000, 3000]])]))
    await settle()

    forwarder.stop()
    forwarder.apply(snapshot([workspace('a', [[3000, 3000]])]))
    await settle()

    expect(set.closes).toBe(1)
    expect(set.reconciled).toHaveLength(1)
  })
})

describe('createPreviewProxies', () => {
  /** A SOCKS5 CONNECT to `localhost:<port>`; resolves the listener's replies. */
  const connect = (proxyPort: number, port: number): Promise<Buffer> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(Buffer.from([5, 1, 0, 5, 1, 0, 3, 9, ...Buffer.from('localhost'), port >> 8, port & 0xff]))
    })
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('close', () => resolve(Buffer.concat(chunks)))
    socket.on('error', reject)
  })

  it('keeps one listener per workspace, which asks for each connection\'s route under its own workspace', async () => {
    const asked: Array<[string, number]> = []
    const proxies = createPreviewProxies((workspaceId, port) => {
      asked.push([workspaceId, port])
      return Promise.resolve(undefined)
    })
    const a = await proxies.portFor('a')
    expect(await proxies.portFor('a')).toBe(a)
    const b = await proxies.portFor('b')
    expect(b).not.toBe(a)

    // No route: refused ("not allowed by ruleset").
    expect([...await connect(a, 3000)]).toEqual([5, 0, 5, 2, 0, 1, 0, 0, 0, 0, 0, 0])
    await connect(b, 4000)
    expect(asked).toEqual([['a', 3000], ['b', 4000]])
  })
})
