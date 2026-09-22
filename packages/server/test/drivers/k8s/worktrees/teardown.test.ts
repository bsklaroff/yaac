import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'

// Mocked at the process boundary: kubectl is the only way this feature
// reaches the cluster, so everything below it runs for real.
const mockKubectl = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  kubectlWithRetry: mockKubectl,
}))

// Port forwards are live host sockets — the registry is the boundary.
const mockStopForwarders = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/forwarders/port-forwarders', () => ({
  stopWorktreeForwarders: mockStopForwarders,
}))

// The salvage runs a survey exec plus node-side pods; the node image store
// removal runs cleanup pods. Both are whole subprocess trees of their own.
const mockSalvage = vi.hoisted(() => vi.fn())
const mockRemoveStore = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/images/image-promoter', () => ({ salvageWorktreeImages: mockSalvage }))
vi.mock('#drivers/k8s/images/store-writer', () => ({ removeNodeImageStore: mockRemoveStore }))

const mockRemoveRegistry = vi.hoisted(() => vi.fn())
const mockRemoveSecrets = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/cluster', async (importOriginal) => ({
  ...(await importOriginal<typeof clusterModule>()),
  removeProjectRegistry: mockRemoveRegistry,
  removeProjectSecrets: mockRemoveSecrets,
}))

import type * as clusterModule from '#drivers/k8s/cluster'
import {
  deregisterWorkspace,
  destroyProjectSubstrate,
  destroyWorkspace,
  detachedTeardownCommand,
  salvageWorkspaceImages,
} from '#drivers/k8s/worktrees/teardown'
import type { TeardownTarget } from '#drivers/contract'

const TARGET: TeardownTarget = {
  projectSlug: 'proj', workspaceId: 's1', unitName: 'yaac-proj-s1',
}

/** The index of the `kubectl delete <kind>` call, if one was made. */
function deleteCallIndex(kind: string): number {
  return mockKubectl.mock.calls
    .map(([args]) => args as string[])
    .findIndex((args) => args[0] === 'delete' && args[1] === kind)
}

/** The `kubectl delete job` call, if one was made. */
function jobDelete(): string[] | undefined {
  const i = deleteCallIndex('job')
  return i < 0 ? undefined : mockKubectl.mock.calls[i][0] as string[]
}

beforeEach(() => {
  mockKubectl.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  mockStopForwarders.mockReset()
  mockSalvage.mockReset().mockResolvedValue(true)
  mockRemoveStore.mockReset().mockResolvedValue(undefined)
  mockRemoveRegistry.mockReset().mockResolvedValue(undefined)
  mockRemoveSecrets.mockReset().mockResolvedValue(undefined)
})

describe('deregisterWorkspace', () => {
  it('drops the port forwards, then the egress registration object', async () => {
    await deregisterWorkspace('s1')

    expect(mockStopForwarders).toHaveBeenCalledWith('s1')
    // The registration is a ConfigMap the proxy watches: deleting it is the
    // whole of the deregistration, proxy or no proxy.
    expect(mockKubectl).toHaveBeenCalledWith(
      ['delete', 'configmap', 'yaac-proxy-reg-s1', '-n', 'yaac', '--ignore-not-found'],
    )
    expect(mockStopForwarders.mock.invocationCallOrder[0])
      .toBeLessThan(mockKubectl.mock.invocationCallOrder[0])
  })

  // A workspace that is going away must never be held up by the datapath.
  it('survives a cluster that fails the removal', async () => {
    mockKubectl.mockRejectedValue(new Error('apiserver down'))
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
    expect(jobDelete()).toBeDefined()
    expect(mockSalvage.mock.invocationCallOrder[0])
      .toBeLessThan(mockKubectl.mock.invocationCallOrder[deleteCallIndex('job')])
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
      expect(deleteCallIndex('configmap')).toBe(-1)
      expect(mockStopForwarders).not.toHaveBeenCalled()
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
  it('deletes the unit', () => {
    expect(detachedTeardownCommand(TARGET)).toContain('kubectl delete job yaac-proj-s1')
  })

  // The whole script is re-issued to resume an interrupted teardown (the
  // reaper does exactly that), so every line has to tolerate having run.
  it('every command is idempotent and cannot fail the script', () => {
    for (const line of detachedTeardownCommand(TARGET).split('; ')) {
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
  it('removes the project registry, its egress secrets and the node image stores', async () => {
    await destroyProjectSubstrate('proj')
    expect(mockRemoveRegistry).toHaveBeenCalledWith('proj')
    expect(mockRemoveSecrets).toHaveBeenCalledWith('proj')
    expect(mockRemoveStore).toHaveBeenCalledWith('proj')
  })

  it('still removes the rest when the egress secrets will not go', async () => {
    mockRemoveSecrets.mockRejectedValue(new Error('cluster offline'))
    await expect(destroyProjectSubstrate('proj')).resolves.toBeUndefined()
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
