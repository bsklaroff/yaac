import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

vi.mock('#platform/k8s/pods', () => ({
  listSessionPods: vi.fn().mockResolvedValue([]),
  listSessionJobs: vi.fn().mockResolvedValue([]),
}))

vi.mock('#features/cluster/vcluster', () => ({
  VCLUSTER_ORPHAN_GRACE_MS: 15 * 60 * 1000,
  listVclusterNamespaces: vi.fn().mockResolvedValue([]),
  removeSessionVcluster: vi.fn().mockResolvedValue(undefined),
  vclusterLabels: vi.fn((name: string, sessionId: string) => ({
    'yaac.vcluster': name,
    'yaac.vcluster-session-id': sessionId,
  })),
  waitForVclusterKubeconfig: vi.fn().mockResolvedValue('kubeconfig-bytes\n'),
}))

vi.mock('#features/cluster/activator', () => ({
  getActivatorPodIp: vi.fn().mockResolvedValue('10.244.0.9'),
  vclusterSleepSliceName: vi.fn((name: string) => `yaac-sleep-${name}`),
  buildVclusterSleepEndpointSliceManifest: vi.fn(
    (name: string, namespace: string, labels: Record<string, string>, ip: string) => ({
      kind: 'EndpointSlice',
      metadata: { name: `yaac-sleep-${name}`, namespace, labels },
      endpoints: [{ addresses: [ip] }],
    }),
  ),
}))

vi.mock('#platform/k8s/kubectl', () => ({
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn().mockResolvedValue(null),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

import {
  healVclusterSleepState,
  reconcileVclusters,
} from '#features/sessions/reconcile/vcluster-reconcile'
import { listSessionJobs, listSessionPods } from '#platform/k8s/pods'
import {
  listVclusterNamespaces,
  removeSessionVcluster,
  waitForVclusterKubeconfig,
} from '#features/cluster/vcluster'
import { getActivatorPodIp } from '#features/cluster/activator'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#platform/k8s/kubectl'
import { sessionVclusterDir } from '@yaac/shared/project-paths'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

const mockPods = vi.mocked(listSessionPods)
const mockJobs = vi.mocked(listSessionJobs)
const mockList = vi.mocked(listVclusterNamespaces)
const mockRemove = vi.mocked(removeSessionVcluster)
const mockWait = vi.mocked(waitForVclusterKubeconfig)
const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)
const mockActivatorIp = vi.mocked(getActivatorPodIp)

const NOW = Date.parse('2026-06-13T12:00:00Z')
/** A vcluster old enough to be past the orphan-GC grace window. */
const OLD_TS = new Date(NOW - 60 * 60 * 1000).toISOString()
/** A vcluster created seconds ago (an in-flight session create). */
const FRESH_TS = new Date(NOW - 5_000).toISOString()

function vcInfo(
  name: string,
  sessionId: string,
  creationTimestamp = OLD_TS,
): { name: string; sessionId: string; namespace: string; creationTimestamp: string } {
  return { name, sessionId, namespace: `yaac-vc-${name.replace(/^yvc-/, '')}`, creationTimestamp }
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockPods.mockReset()
  mockPods.mockResolvedValue([])
  mockJobs.mockReset()
  mockJobs.mockResolvedValue([])
  mockList.mockReset()
  mockList.mockResolvedValue([])
  mockRemove.mockReset()
  mockRemove.mockResolvedValue(undefined)
  mockWait.mockReset()
  mockWait.mockResolvedValue('kubeconfig-bytes\n')
  mockApply.mockClear()
  mockGetJson.mockReset()
  mockGetJson.mockResolvedValue(null)
  mockRetry.mockClear()
  mockActivatorIp.mockReset()
  mockActivatorIp.mockResolvedValue('10.244.0.9')
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

describe('reconcileVclusters', () => {
  it('does nothing (not even a pod list) when no vclusters exist', async () => {
    await reconcileVclusters(NOW)
    expect(mockPods).not.toHaveBeenCalled()
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('tears down vclusters whose session pod AND Job are gone', async () => {
    mockList.mockResolvedValue([vcInfo('yvc-deadbeef', 'deadbeef-1111')])
    await reconcileVclusters(NOW)
    expect(mockRemove).toHaveBeenCalledWith('yvc-deadbeef')
  })

  it('spares a freshly-created vcluster from the orphan GC (in-flight create)', async () => {
    // createSession stands the vcluster up BEFORE the session Job, so for
    // a window the vcluster's session-id matches no live pod/Job. The GC
    // must not reap it during that window or it kills the provisioning
    // session.
    mockList.mockResolvedValue([vcInfo('yvc-deadbeef', 'deadbeef-1111', FRESH_TS)])
    await reconcileVclusters(NOW)
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('keeps a vcluster whose session only shows in the Job list (pod mid-recreate)', async () => {
    mockList.mockResolvedValue([vcInfo('yvc-deadbeef', 'deadbeef-1111')])
    mockJobs.mockResolvedValue([
      { jobName: 'yaac-p-deadbeef-1111', sessionId: 'deadbeef-1111', projectSlug: 'p', createdAtMs: 0 },
    ])
    await reconcileVclusters(NOW)
    expect(mockRemove).not.toHaveBeenCalled()
    // No pod row → no slug → the kubeconfig heal waits for a later tick.
    expect(mockWait).not.toHaveBeenCalled()
  })

  it('heals a live session\'s missing kubeconfig from the secret', async () => {
    mockList.mockResolvedValue([vcInfo('yvc-deadbeef', 'deadbeef-1111')])
    mockPods.mockResolvedValue([
      { sessionId: 'deadbeef-1111', projectSlug: 'proj' } as never,
    ])
    await reconcileVclusters(NOW)
    expect(mockRemove).not.toHaveBeenCalled()
    const configPath = path.join(sessionVclusterDir('proj', 'deadbeef-1111'), 'config')
    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe('kubeconfig-bytes\n')
  })

  it('reads all three listings from the tick snapshot when one is provided', async () => {
    const snapshot = {
      resync: true,
      pods: vi.fn().mockResolvedValue([]),
      jobs: vi.fn().mockResolvedValue([]),
      vclusters: vi.fn().mockResolvedValue([vcInfo('yvc-deadbeef', 'deadbeef-1111')]),
      vclusterPods: vi.fn(() => Promise.resolve([])),
      vclusterServices: vi.fn(() => Promise.resolve([])),
      vclusterConfigMaps: vi.fn(() => Promise.resolve([])),
    }
    await reconcileVclusters(NOW, snapshot)
    expect(mockList).not.toHaveBeenCalled()
    expect(mockPods).not.toHaveBeenCalled()
    expect(mockJobs).not.toHaveBeenCalled()
    expect(mockRemove).toHaveBeenCalledWith('yvc-deadbeef')
  })

  it('leaves a present kubeconfig untouched', async () => {
    mockList.mockResolvedValue([vcInfo('yvc-deadbeef', 'deadbeef-1111')])
    mockPods.mockResolvedValue([
      { sessionId: 'deadbeef-1111', projectSlug: 'proj' } as never,
    ])
    const dir = sessionVclusterDir('proj', 'deadbeef-1111')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'config'), 'existing\n')
    await reconcileVclusters(NOW)
    expect(mockWait).not.toHaveBeenCalled()
    await expect(fs.readFile(path.join(dir, 'config'), 'utf8')).resolves.toBe('existing\n')
  })
})

describe('healVclusterSleepState', () => {
  const VC = 'yvc-deadbeef'
  const NS = 'yaac-vc-deadbeef'
  const SLICE = `yaac-sleep-${VC}`
  const LABELS = { 'yaac.vcluster': VC }

  function primeCluster(state: {
    replicas: number
    readyReplicas?: number
    sliceIp?: string
  }): void {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      if (args[1] === 'deployment') {
        return Promise.resolve({
          spec: { replicas: state.replicas },
          status: { readyReplicas: state.readyReplicas ?? 0 },
        })
      }
      if (args[1] === 'endpointslice') {
        return Promise.resolve(state.sliceIp !== undefined
          ? { endpoints: [{ addresses: [state.sliceIp] }] }
          : null)
      }
      return Promise.resolve(null)
    })
  }

  it('no-ops when the deployment is gone (vcluster mid-teardown)', async () => {
    await healVclusterSleepState(VC, NS, LABELS)
    expect(mockApply).not.toHaveBeenCalled()
    expect(mockRetry).not.toHaveBeenCalled()
  })

  it('deletes a leftover slice once the vcluster is awake and serving', async () => {
    primeCluster({ replicas: 1, readyReplicas: 1, sliceIp: '10.244.0.9' })
    await healVclusterSleepState(VC, NS, LABELS)
    expect(mockRetry).toHaveBeenCalledWith([
      'delete', 'endpointslice', SLICE, '-n', NS, '--ignore-not-found',
    ])
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('leaves the slice alone while the vcluster is WAKING (the activator still needs it)', async () => {
    primeCluster({ replicas: 1, readyReplicas: 0, sliceIp: '10.244.0.9' })
    await healVclusterSleepState(VC, NS, LABELS)
    expect(mockRetry).not.toHaveBeenCalled()
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('re-points an asleep vcluster\'s slice at the live activator pod IP', async () => {
    // The activator pod was replaced: the slice still targets the old IP,
    // which would strand the asleep vcluster unreachable.
    primeCluster({ replicas: 0, sliceIp: '10.244.0.1' })
    await healVclusterSleepState(VC, NS, LABELS)
    expect(mockApply).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'EndpointSlice',
      endpoints: [{ addresses: ['10.244.0.9'] }],
    }))
  })

  it('recreates a missing slice for an asleep vcluster (black-holed API)', async () => {
    primeCluster({ replicas: 0 })
    await healVclusterSleepState(VC, NS, LABELS)
    expect(mockApply).toHaveBeenCalledWith(expect.objectContaining({ kind: 'EndpointSlice' }))
  })

  it('no-ops when the slice already targets the live activator', async () => {
    primeCluster({ replicas: 0, sliceIp: '10.244.0.9' })
    await healVclusterSleepState(VC, NS, LABELS)
    expect(mockApply).not.toHaveBeenCalled()
    expect(mockRetry).not.toHaveBeenCalled()
  })

  it('leaves state untouched when no activator pod is live', async () => {
    primeCluster({ replicas: 0, sliceIp: '10.244.0.1' })
    mockActivatorIp.mockRejectedValue(new Error('no running activator pod'))
    await healVclusterSleepState(VC, NS, LABELS)
    expect(mockApply).not.toHaveBeenCalled()
  })
})
