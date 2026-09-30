import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'

// Mock kubectl, the only way this reaches the cluster.
const mockKubectl = vi.hoisted(() => vi.fn())
const mockGetJson = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  kubectlWithRetry: mockKubectl,
  kubectlGetJson: mockGetJson,
}))

// Mock the forwarder registry, which holds live sockets.
const mockStopForwarders = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/forwarders/port-forwarders', () => ({
  stopWorkspaceForwarders: mockStopForwarders,
}))

// Mock salvage and image-store removal, which run their own pods.
const mockSalvage = vi.hoisted(() => vi.fn())
const mockRemoveStore = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/images/image-promoter', () => ({ salvageJobImages: mockSalvage }))
vi.mock('#drivers/k8s/images/store-writer', () => ({ removeNodeLocalProject: mockRemoveStore }))

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
} from '#drivers/k8s/workspaces/teardown'
import type { TeardownTarget } from '#drivers/contract'

const TARGET: TeardownTarget = {
  projectSlug: 'proj', workspaceId: 's1', unitName: 'yaac-proj-s1',
}
const PROJECT = { slug: 'proj', id: '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c' }

/** The workspace's pod as the cluster lists it, labelled with `labels`. */
function podList(labels: Record<string, string>): unknown {
  return {
    items: [{
      metadata: {
        name: 'yaac-proj-s1-abcde',
        labels: {
          'batch.kubernetes.io/job-name': 'yaac-proj-s1',
          'yaac.workspace-id': 's1',
          'yaac.project': 'proj',
          'yaac.tool': 'claude',
          ...labels,
        },
        creationTimestamp: '2026-09-29T00:00:00Z',
      },
      status: { phase: 'Running' },
    }],
  }
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
  mockGetJson.mockReset().mockResolvedValue(podList({ 'yaac.project-id': PROJECT.id }))
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
    // Deleting the ConfigMap the proxy watches is the whole deregistration.
    expect(mockKubectl).toHaveBeenCalledWith(
      ['delete', 'configmap', 'yaac-proxy-reg-s1', '-n', 'yaac', '--ignore-not-found'],
    )
    expect(mockStopForwarders.mock.invocationCallOrder[0])
      .toBeLessThan(mockKubectl.mock.invocationCallOrder[0])
  })

  it('survives a cluster that fails the removal', async () => {
    mockKubectl.mockRejectedValue(new Error('apiserver down'))
    await expect(deregisterWorkspace('s1')).resolves.toBeUndefined()
    expect(mockStopForwarders).toHaveBeenCalledWith('s1')
  })
})

describe('salvageWorkspaceImages', () => {
  it('salvages by the unit the workspace runs in, into the registry its pod\'s project id names', async () => {
    await salvageWorkspaceImages(TARGET)
    expect(mockSalvage).toHaveBeenCalledWith({
      jobName: 'yaac-proj-s1', project: PROJECT, workspaceId: 's1',
    })
  })

  // No project id means no registry to push to.
  it('skips a pod that carries no project id', async () => {
    mockGetJson.mockResolvedValue(podList({}))
    await salvageWorkspaceImages(TARGET)
    expect(mockSalvage).not.toHaveBeenCalled()
  })

  // A failed salvage only costs a rebuild, so it must not block teardown.
  it('never throws when the salvage fails', async () => {
    mockSalvage.mockRejectedValue(new Error('registry down'))
    await expect(salvageWorkspaceImages(TARGET)).resolves.toBeUndefined()
  })
})

describe('destroyWorkspace', () => {
  it('stops routing, salvages, then deletes the unit — in that order', async () => {
    await expect(destroyWorkspace(TARGET)).resolves.toBe(true)

    // Salvage execs into the pod, so it must precede the delete.
    expect(mockStopForwarders.mock.invocationCallOrder[0])
      .toBeLessThan(mockSalvage.mock.invocationCallOrder[0])
    expect(jobDelete()).toBeDefined()
    expect(mockSalvage.mock.invocationCallOrder[0])
      .toBeLessThan(mockKubectl.mock.invocationCallOrder[deleteCallIndex('job')])
  })

  // Callers delete the checkout next, so the pod must be gone. Only a
  // foreground cascade waits for the pod, not just the Job object.
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

  // `unitOnly` is for a failed launch or a restart: the workspace comes back,
  // so what a relaunch reuses must survive.
  describe('unitOnly', () => {
    it('takes the unit down and leaves the egress registration standing', async () => {
      // Registered once per create, so retries need it to stay.
      await expect(
        destroyWorkspace(TARGET, { salvageImages: false, unitOnly: true }),
      ).resolves.toBe(true)

      expect(jobDelete()).toEqual(expect.arrayContaining(['--cascade=foreground']))
      expect(deleteCallIndex('configmap')).toBe(-1)
      expect(mockStopForwarders).not.toHaveBeenCalled()
    })

    it('still reports a unit it could not confirm gone', async () => {
      mockKubectl.mockRejectedValue(new Error('timed out'))

      await expect(
        destroyWorkspace(TARGET, { salvageImages: false, unitOnly: true }),
      ).resolves.toBe(false)
    })
  })

describe('detachedTeardownCommand', () => {
  it('deletes the unit, and waits for its pod: the session dir removed next holds the pod\'s File mounts', () => {
    const cmd = detachedTeardownCommand(TARGET)
    expect(cmd).toContain('kubectl delete job yaac-proj-s1')
    expect(cmd).toContain('--cascade=foreground')
    expect(cmd).toContain('--wait=true')
    expect(cmd).toMatch(/--timeout=\d+s/)
  })

  // The reaper re-runs the whole script to resume a teardown.
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
  it('removes the project registry, its egress secrets and the node-local trees', async () => {
    await destroyProjectSubstrate(PROJECT)
    // Most objects are keyed by id; egress secrets by slug.
    expect(mockRemoveRegistry).toHaveBeenCalledWith(PROJECT.id)
    expect(mockRemoveSecrets).toHaveBeenCalledWith('proj')
    expect(mockRemoveStore).toHaveBeenCalledWith(PROJECT.id)
  })

  it('still removes the rest when the egress secrets will not go', async () => {
    mockRemoveSecrets.mockRejectedValue(new Error('cluster offline'))
    await expect(destroyProjectSubstrate(PROJECT)).resolves.toBeUndefined()
    expect(mockRemoveStore).toHaveBeenCalledWith(PROJECT.id)
  })

  // One failing piece must not block the others.
  it('still removes the image stores when the registry teardown fails', async () => {
    mockRemoveRegistry.mockRejectedValue(new Error('cluster offline'))
    await expect(destroyProjectSubstrate(PROJECT)).resolves.toBeUndefined()
    expect(mockRemoveStore).toHaveBeenCalledWith(PROJECT.id)
  })

  it('survives a failing image-store removal', async () => {
    mockRemoveStore.mockRejectedValue(new Error('node gone'))
    await expect(destroyProjectSubstrate(PROJECT)).resolves.toBeUndefined()
  })
})
