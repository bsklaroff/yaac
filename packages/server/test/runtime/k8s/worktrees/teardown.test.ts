import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as kubectlModule from '#platform/k8s/kubectl'

// Mocked at the process boundary: kubectl is the only way this feature
// reaches the cluster, so everything below it runs for real.
const mockKubectl = vi.hoisted(() => vi.fn())
vi.mock('#platform/k8s/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  kubectlWithRetry: mockKubectl,
}))

// The proxy speaks HTTP through an exec tunnel; the client is its process
// boundary, and a teardown only ever attaches and deletes.
const mockAttach = vi.hoisted(() => vi.fn())
const mockRemoveWorktree = vi.hoisted(() => vi.fn())
vi.mock('#runtime/k8s/egress/proxy-client', () => ({
  proxyClient: { attachIfRunning: mockAttach, removeWorktree: mockRemoveWorktree },
}))

// Port forwards are live host sockets — the registry is the boundary.
const mockStopForwarders = vi.hoisted(() => vi.fn())
vi.mock('#runtime/k8s/forwarders/port-forwarders', () => ({
  stopWorktreeForwarders: mockStopForwarders,
}))

// The salvage runs a survey exec plus node-side pods; the node image store
// removal runs cleanup pods. Both are whole subprocess trees of their own.
const mockSalvage = vi.hoisted(() => vi.fn())
const mockRemoveStore = vi.hoisted(() => vi.fn())
vi.mock('#runtime/k8s/images/image-promoter', () => ({ salvageWorktreeImages: mockSalvage }))
vi.mock('#runtime/k8s/images/store-writer', () => ({ removeNodeImageStore: mockRemoveStore }))

const mockVclusterStatus = vi.hoisted(() => vi.fn())
const mockRemoveVcluster = vi.hoisted(() => vi.fn())
const mockRemoveRegistry = vi.hoisted(() => vi.fn())
vi.mock('#runtime/k8s/cluster', async (importOriginal) => ({
  ...(await importOriginal<typeof clusterModule>()),
  getVclusterStatus: mockVclusterStatus,
  removeWorktreeVcluster: mockRemoveVcluster,
  removeProjectRegistry: mockRemoveRegistry,
}))

import type * as clusterModule from '#runtime/k8s/cluster'
import {
  deregisterWorkspace,
  destroyProjectSubstrate,
  destroyWorkspace,
  detachedTeardownCommand,
  salvageWorkspaceImages,
} from '#runtime/k8s/worktrees/teardown'
import { vclusterName } from '#runtime/k8s/cluster'
import type { TeardownTarget } from '#runtime/contract'

const TARGET: TeardownTarget = {
  projectSlug: 'proj', workspaceId: 's1', unitName: 'yaac-proj-s1',
}

/** The `kubectl delete job` call, if one was made. */
function jobDelete(): string[] | undefined {
  return mockKubectl.mock.calls
    .map(([args]) => args as string[])
    .find((args) => args[0] === 'delete' && args[1] === 'job')
}

beforeEach(() => {
  mockKubectl.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  mockAttach.mockReset().mockResolvedValue(true)
  mockRemoveWorktree.mockReset().mockResolvedValue(undefined)
  mockStopForwarders.mockReset()
  mockSalvage.mockReset().mockResolvedValue(true)
  mockRemoveStore.mockReset().mockResolvedValue(undefined)
  mockVclusterStatus.mockReset().mockResolvedValue(null)
  mockRemoveVcluster.mockReset().mockResolvedValue(undefined)
  mockRemoveRegistry.mockReset().mockResolvedValue(undefined)
})

describe('deregisterWorkspace', () => {
  it('drops the port forwards, then the proxy registration', async () => {
    await deregisterWorkspace('s1')

    expect(mockStopForwarders).toHaveBeenCalledWith('s1')
    expect(mockRemoveWorktree).toHaveBeenCalledWith('s1')
    expect(mockStopForwarders.mock.invocationCallOrder[0])
      .toBeLessThan(mockRemoveWorktree.mock.invocationCallOrder[0])
  })

  // The proxy deploys lazily on the first create, so "no proxy" is the
  // normal state of a fresh install — not something to stand one up for.
  it('does not talk to an absent proxy', async () => {
    mockAttach.mockResolvedValue(false)
    await deregisterWorkspace('s1')
    expect(mockRemoveWorktree).not.toHaveBeenCalled()
  })

  // A workspace that is going away must never be held up by the datapath.
  it('survives a proxy that fails the removal', async () => {
    mockRemoveWorktree.mockRejectedValue(new Error('tunnel down'))
    await expect(deregisterWorkspace('s1')).resolves.toBeUndefined()
    expect(mockStopForwarders).toHaveBeenCalledWith('s1')
  })
})

describe('salvageWorkspaceImages', () => {
  it('salvages by the unit the workspace runs in', async () => {
    await salvageWorkspaceImages(TARGET)
    expect(mockSalvage).toHaveBeenCalledWith({
      jobName: 'yaac-proj-s1', projectSlug: 'proj', worktreeId: 's1',
    })
  })

  // Losing a salvage costs a rebuild; stranding a teardown costs a leaked
  // workspace, so the failure is swallowed here rather than upward.
  it('never throws when the salvage fails', async () => {
    mockSalvage.mockRejectedValue(new Error('registry down'))
    await expect(salvageWorkspaceImages(TARGET)).resolves.toBeUndefined()
  })
})

describe('destroyWorkspace', () => {
  it('stops routing, salvages, then deletes the unit — in that order', async () => {
    await expect(destroyWorkspace(TARGET)).resolves.toBe(true)

    // The salvage execs into the pod the delete destroys, and routing must
    // stop before either.
    expect(mockStopForwarders.mock.invocationCallOrder[0])
      .toBeLessThan(mockSalvage.mock.invocationCallOrder[0])
    expect(mockSalvage.mock.invocationCallOrder[0])
      .toBeLessThan(mockKubectl.mock.invocationCallOrder[0])
    expect(jobDelete()).toBeDefined()
  })

  // Callers chain a checkout removal off the verdict, so "the unit is gone"
  // has to mean "the pod is gone". Only a FOREGROUND cascade gives that:
  // under kubectl's default background propagation `--wait` returns once the
  // Job object is deleted, while the pod runs on through its grace period
  // still writing to /workspace.
  it('deletes the Job with a waited foreground cascade and a deadline', async () => {
    await destroyWorkspace(TARGET)

    expect(jobDelete()).toEqual(expect.arrayContaining([
      'delete', 'job', 'yaac-proj-s1',
      '--ignore-not-found', '--cascade=foreground', '--wait=true', '--timeout=30s',
    ]))
  })

  it('reports the unit NOT gone when the delete times out', async () => {
    mockKubectl.mockRejectedValue(new Error('timed out waiting for the condition'))
    await expect(destroyWorkspace(TARGET)).resolves.toBe(false)
  })

  // One cheap probe gates the label-selector deletes, so a workspace that
  // never had a nested cluster pays a single read rather than a sweep.
  it('removes the nested cluster only when the workspace has one', async () => {
    await destroyWorkspace(TARGET)
    expect(mockRemoveVcluster).not.toHaveBeenCalled()

    mockVclusterStatus.mockResolvedValue({ name: 'yvc-s1', ready: true, phase: 'ready' })
    await destroyWorkspace(TARGET)
    expect(mockRemoveVcluster).toHaveBeenCalledWith(vclusterName('s1'))
    // After the unit is gone: its pods are what the nested cluster serves.
    expect(mockKubectl.mock.invocationCallOrder[0])
      .toBeLessThan(mockRemoveVcluster.mock.invocationCallOrder[0])
  })

  // The reconcile sweep collects a nested cluster this misses; a teardown
  // that threw here would leave the caller's own bookkeeping half done.
  it('survives a nested-cluster probe that fails, still reporting the unit gone', async () => {
    mockVclusterStatus.mockRejectedValue(new Error('apiserver down'))
    await expect(destroyWorkspace(TARGET)).resolves.toBe(true)
  })

  it('skips the salvage when the caller is about to destroy where it would go', async () => {
    await destroyWorkspace(TARGET, { salvageImages: false })
    expect(mockSalvage).not.toHaveBeenCalled()
    expect(jobDelete()).toBeDefined()
  })
})

  // `unitOnly` is the failed-launch and kept-checkout shape: the workspace
  // is coming back, either on the next attempt or on a restart, so the two
  // things a relaunch reuses have to survive it.
  describe('unitOnly', () => {
    it('takes the unit down and leaves the egress registration standing', async () => {
      // The registration is made ONCE for a whole create; dropping it
      // between attempts would leave the next one reaching nothing.
      await expect(
        destroyWorkspace(TARGET, { salvageImages: false, unitOnly: true }),
      ).resolves.toBe(true)

      expect(jobDelete()).toEqual(expect.arrayContaining(['--cascade=foreground']))
      expect(mockRemoveWorktree).not.toHaveBeenCalled()
      expect(mockStopForwarders).not.toHaveBeenCalled()
    })

    it('leaves the nested cluster standing for the next attempt', async () => {
      // The caller prepared its substrate once and is about to launch
      // again against the same receipt — including a kubeconfig already
      // written to disk for this vcluster.
      mockVclusterStatus.mockResolvedValue({ name: 'vc-s1', ready: true, phase: 'ready' })

      await destroyWorkspace(TARGET, { salvageImages: false, unitOnly: true })

      expect(mockRemoveVcluster).not.toHaveBeenCalled()
    })

    it('still reports a unit it could not confirm gone', async () => {
      // The verdict is what gates removing the checkout, so it means the
      // same thing whichever shape the teardown took.
      mockKubectl.mockRejectedValue(new Error('timed out'))

      await expect(
        destroyWorkspace(TARGET, { salvageImages: false, unitOnly: true }),
      ).resolves.toBe(false)
    })
  })

describe('detachedTeardownCommand', () => {
  it('deletes the unit and sweeps the nested cluster', () => {
    const script = detachedTeardownCommand(TARGET)
    expect(script).toContain('kubectl delete job yaac-proj-s1')
    // Pure label-selector deletes, so a workspace with no nested cluster
    // no-ops rather than needing a branch the shell cannot take.
    expect(script).toContain(vclusterName('s1'))
  })

  // The whole script is re-issued to resume an interrupted teardown (the
  // reaper does exactly that), so every line has to tolerate having run.
  it('every command is idempotent and cannot fail the script', () => {
    const lines = detachedTeardownCommand(TARGET).split('; ')
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(line).toContain('--ignore-not-found')
      expect(line).toContain('|| true')
    }
  })

  it('runs nothing itself — it only composes', () => {
    detachedTeardownCommand(TARGET)
    expect(mockKubectl).not.toHaveBeenCalled()
  })
})

describe('destroyProjectSubstrate', () => {
  it('removes the project registry and the node image stores', async () => {
    await destroyProjectSubstrate('proj')
    expect(mockRemoveRegistry).toHaveBeenCalledWith('proj')
    expect(mockRemoveStore).toHaveBeenCalledWith('proj')
  })

  // They fail for unrelated reasons and neither is recoverable by the
  // other, so one unreachable piece must not strand the rest.
  it('still removes the image stores when the registry teardown fails', async () => {
    mockRemoveRegistry.mockRejectedValue(new Error('cluster offline'))
    await expect(destroyProjectSubstrate('proj')).resolves.toBeUndefined()
    expect(mockRemoveStore).toHaveBeenCalledWith('proj')
  })

  it('survives a failing image-store removal', async () => {
    mockRemoveStore.mockRejectedValue(new Error('node gone'))
    await expect(destroyProjectSubstrate('proj')).resolves.toBeUndefined()
  })
})
