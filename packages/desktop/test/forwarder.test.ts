/**
 * The desktop forwarder's wiring. The reconciler itself is tested in
 * `@yaac/shared`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { startForwarder } from '#forwarder'
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
    agentSessions: [],
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
      live: () => [],
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
