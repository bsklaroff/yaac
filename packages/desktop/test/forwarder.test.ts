/**
 * The desktop shell as the resident port forwarder.
 *
 * The reconciler has its own suite in `@yaac/shared`; what is tested here
 * is the wiring — that a snapshot becomes the desired set, that snapshots
 * arriving faster than binds settle do not stack up, and that a switched
 * server takes its forwards with it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { snapshotForwards, startForwarder } from '#forwarder'
import type { ForwardSpec } from '@yaac/shared/port-tunnel'
import type { ServerTarget } from '@yaac/shared/server-api'
import type { ServerSnapshot, WorktreeListEntry } from '@yaac/shared/types'

const LOCAL: ServerTarget = { baseUrl: 'http://127.0.0.1:8787', secret: 's', remote: false }
const OTHER: ServerTarget = { baseUrl: 'https://srv.ts.net', secret: 't', remote: true }

function worktree(worktreeId: string, ports: Array<[number, number]>): WorktreeListEntry {
  return {
    worktreeId,
    projectSlug: 'proj',
    tool: 'claude',
    mode: 'tui',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    jobName: `yaac-proj-${worktreeId}`,
    agentSessions: [],
    blockedHosts: [],
    unforwardedPorts: [],
    forwardedPorts: ports.map(([containerPort, hostPort]) => ({ containerPort, hostPort })),
  } as unknown as WorktreeListEntry
}

function snapshot(
  worktrees: WorktreeListEntry[],
  driver: ServerSnapshot['driver'] = 'k8s',
): ServerSnapshot {
  return { driver, worktrees } as unknown as ServerSnapshot
}

/** A fake reconciler standing in for the shared one: records every desired
 *  set it was handed, and how many sets it has been given. */
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

describe('snapshotForwards', () => {
  it('flattens every worktree\'s offered mappings into one desired set', () => {
    expect(snapshotForwards(snapshot([
      worktree('a', [[3000, 3000], [5432, 15432]]),
      worktree('b', [[3000, 3001]]),
      worktree('c', []),
    ]))).toEqual([
      { session: 'a', containerPort: 3000, hostPort: 3000 },
      { session: 'a', containerPort: 5432, hostPort: 15432 },
      { session: 'b', containerPort: 3000, hostPort: 3001 },
    ])
  })

  it('offers nothing under containerless, where the workspace binds its own', () => {
    // Not an empty listing — a listing this client must not act on. Those
    // ports are already bound on this machine by the dev servers
    // themselves, so binding them is a retry loop that can never settle
    // (docs/port-forward-tunnel.md).
    expect(snapshotForwards(snapshot([
      worktree('a', [[3000, 3000]]),
    ], 'containerless'))).toEqual([])
  })
})

describe('startForwarder', () => {
  it('reconciles the snapshot against the resolved server', async () => {
    const forwarder = startForwarder({ resolveTarget, createSet: set.create as never })

    forwarder.apply(snapshot([worktree('a', [[3000, 3000]])]))
    await settle()

    expect(set.targets).toEqual([LOCAL.baseUrl])
    expect(set.reconciled).toEqual([[{ session: 'a', containerPort: 3000, hostPort: 3000 }]])
  })

  it('coalesces a burst of snapshots down to the newest', async () => {
    // Snapshots arrive faster than binds settle; replaying every one would
    // walk the set through states the server has already left, unbinding
    // and rebinding ports for no reason.
    const forwarder = startForwarder({ resolveTarget, createSet: set.create as never })

    forwarder.apply(snapshot([worktree('a', [[3000, 3000]])]))
    forwarder.apply(snapshot([worktree('a', [[3001, 3001]])]))
    forwarder.apply(snapshot([worktree('a', [[3002, 3002]])]))
    await settle()

    expect(set.reconciled).toEqual([[{ session: 'a', containerPort: 3002, hostPort: 3002 }]])
  })

  it('rebuilds against a switched server rather than reconciling onto it', async () => {
    // A different server is a different set of forwards; carrying the old
    // ones over would leave the tray tunnelling to a server nobody is
    // looking at.
    const forwarder = startForwarder({ resolveTarget, createSet: set.create as never })
    forwarder.apply(snapshot([worktree('a', [[3000, 3000]])]))
    await settle()

    resolveTarget.mockResolvedValue(OTHER)
    forwarder.apply(snapshot([worktree('a', [[3000, 3000]])]))
    await settle()

    expect(set.targets).toEqual([LOCAL.baseUrl, OTHER.baseUrl])
    expect(set.closes).toBe(1)
  })

  it('reuses the set while the server is unchanged', async () => {
    const forwarder = startForwarder({ resolveTarget, createSet: set.create as never })
    forwarder.apply(snapshot([worktree('a', [[3000, 3000]])]))
    await settle()
    forwarder.apply(snapshot([worktree('a', [[3000, 3000]])]))
    await settle()

    expect(set.create).toHaveBeenCalledTimes(1)
  })

  it('says so and carries on when the target cannot be resolved', async () => {
    // A restarting server rotates its port and secret; the next snapshot
    // resolves the fresh one.
    resolveTarget.mockRejectedValueOnce(new Error('yaac server is not running'))
    const said: string[] = []
    const forwarder = startForwarder({
      resolveTarget,
      createSet: set.create as never,
      onMessage: (t) => said.push(t),
    })

    forwarder.apply(snapshot([worktree('a', [[3000, 3000]])]))
    await settle()
    expect(said.join(' ')).toContain('yaac server is not running')

    forwarder.apply(snapshot([worktree('a', [[3000, 3000]])]))
    await settle()
    expect(set.reconciled).toHaveLength(1)
  })

  it('lets every forward go on stop, and takes no more snapshots', async () => {
    const forwarder = startForwarder({ resolveTarget, createSet: set.create as never })
    forwarder.apply(snapshot([worktree('a', [[3000, 3000]])]))
    await settle()

    forwarder.stop()
    forwarder.apply(snapshot([worktree('a', [[3000, 3000]])]))
    await settle()

    expect(set.closes).toBe(1)
    expect(set.reconciled).toHaveLength(1)
  })
})
