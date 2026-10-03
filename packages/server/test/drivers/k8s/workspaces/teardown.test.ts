import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as childProcessModule from 'node:child_process'
import { apiError, fakeCluster } from '@yaac/test-utils/k8s-stub'

/** Every step that reaches outside, in order. */
const order: string[] = []

// The Job delete is a `kubectl delete` child process; everything else
// reaches the fake cluster.
type ExecCallback = (err: unknown, res?: { stdout: string; stderr: string }) => void
const kubectlArgs: string[][] = []
const kubectlFailure = vi.hoisted(() => ({ error: null as Error | null }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof childProcessModule>(),
  execFile: (_file: string, args: string[], _opts: unknown, cb: ExecCallback) => {
    kubectlArgs.push(args)
    order.push(`kubectl ${args.slice(0, 2).join(' ')}`)
    process.nextTick(() => { cb(kubectlFailure.error, { stdout: '', stderr: '' }) })
  },
}))

// Mock the forwarder registry, which holds live sockets.
const mockStopForwarders = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/forwarders/port-forwarders', () => ({
  stopWorkspaceForwarders: mockStopForwarders,
}))

// Mock salvage, which runs its own pods.
const mockSalvage = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/images/image-promoter', () => ({ salvageJobImages: mockSalvage }))

const mockRemoveRegistry = vi.hoisted(() => vi.fn())
const mockRemoveSecrets = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/cluster', async (importOriginal) => ({
  ...(await importOriginal<typeof clusterModule>()),
  removeProjectRegistry: mockRemoveRegistry,
  removeProjectSecrets: mockRemoveSecrets,
}))

import type * as clusterModule from '#drivers/k8s/cluster'
import { LABEL_DATA_DIR_HASH, dataDirHash, k8sNamespace } from '#drivers/k8s/substrate'
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

/** Put the workspace's pod in the cluster, labelled with `labels`. */
function seedPod(labels: Record<string, string>): void {
  fakeCluster.seed({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: 'yaac-proj-s1-abcde',
      namespace: k8sNamespace(),
      labels: {
        [LABEL_DATA_DIR_HASH]: dataDirHash(),
        'batch.kubernetes.io/job-name': 'yaac-proj-s1',
          'yaac.workspace-id': 's1',
          'yaac.project': 'proj',
        'yaac.tool': 'claude',
        ...labels,
      },
      creationTimestamp: '2026-09-29T00:00:00Z',
    },
    status: { phase: 'Running' },
  })
}

/** Put the workspace's egress registration in the cluster. */
function seedRegistration(): void {
  fakeCluster.seed({
    apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'yaac-proxy-reg-s1', namespace: k8sNamespace() },
  })
}

/** The `kubectl delete job` argv, if one was run. */
function jobDelete(): string[] | undefined {
  return kubectlArgs.find((args) => args[0] === 'delete' && args[1] === 'job')
}

beforeEach(() => {
  order.length = 0
  kubectlArgs.length = 0
  kubectlFailure.error = null
  seedPod({ 'yaac.project-id': PROJECT.id })
  seedRegistration()
  fakeCluster.intercept((c) => { if (c.verb === 'delete') order.push(`delete ${c.kind}`) })
  mockStopForwarders.mockReset().mockImplementation(() => { order.push('stop forwarders') })
  mockSalvage.mockReset().mockImplementation(() => {
    order.push('salvage')
    return Promise.resolve(true)
  })
  mockRemoveRegistry.mockReset().mockResolvedValue(undefined)
  mockRemoveSecrets.mockReset().mockResolvedValue(undefined)
})

describe('deregisterWorkspace', () => {
  it('drops the port forwards, then the egress registration object', async () => {
    await deregisterWorkspace('s1')

    expect(mockStopForwarders).toHaveBeenCalledWith('s1')
    // Deleting the ConfigMap the proxy watches is the whole deregistration.
    expect(order).toEqual(['stop forwarders', 'delete ConfigMap'])
    expect(fakeCluster.get('ConfigMap', 'yaac-proxy-reg-s1')).toBeUndefined()
  })

  it('survives a cluster that fails the removal', async () => {
    fakeCluster.intercept(() => { throw apiError(503, 'apiserver down') })
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

  it('skips a workspace whose pod is gone', async () => {
    fakeCluster.reset()
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
    expect(order).toEqual(['stop forwarders', 'delete ConfigMap', 'salvage', 'kubectl delete job'])
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
    kubectlFailure.error = new Error('timed out waiting for the condition')
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
      expect(fakeCluster.get('ConfigMap', 'yaac-proxy-reg-s1')).toBeDefined()
      expect(mockStopForwarders).not.toHaveBeenCalled()
    })

    it('still reports a unit it could not confirm gone', async () => {
      kubectlFailure.error = new Error('timed out')

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
    expect(order).toEqual([])
  })
})

describe('destroyProjectSubstrate', () => {
  it('removes the project registry and its egress secrets', async () => {
    await destroyProjectSubstrate(PROJECT)
    // The registry is keyed by id; egress secrets by slug.
    expect(mockRemoveRegistry).toHaveBeenCalledWith(PROJECT.id)
    expect(mockRemoveSecrets).toHaveBeenCalledWith('proj')
  })

  // One failing piece must not block the other.
  it('still removes each when the other fails', async () => {
    mockRemoveRegistry.mockRejectedValue(new Error('cluster offline'))
    await expect(destroyProjectSubstrate(PROJECT)).resolves.toBeUndefined()
    expect(mockRemoveSecrets).toHaveBeenCalledWith('proj')

    mockRemoveRegistry.mockReset()
    mockRemoveSecrets.mockRejectedValue(new Error('cluster offline'))
    await expect(destroyProjectSubstrate(PROJECT)).resolves.toBeUndefined()
    expect(mockRemoveRegistry).toHaveBeenCalledWith(PROJECT.id)
  })
})
