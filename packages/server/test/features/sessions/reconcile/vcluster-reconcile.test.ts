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
  waitForVclusterKubeconfig: vi.fn().mockResolvedValue('kubeconfig-bytes\n'),
}))

import { reconcileVclusters } from '#features/sessions/reconcile/vcluster-reconcile'
import { listSessionJobs, listSessionPods } from '#platform/k8s/pods'
import {
  listVclusterNamespaces,
  removeSessionVcluster,
  waitForVclusterKubeconfig,
} from '#features/cluster/vcluster'
import { sessionVclusterDir } from '@yaac/shared/project-paths'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

const mockPods = vi.mocked(listSessionPods)
const mockJobs = vi.mocked(listSessionJobs)
const mockList = vi.mocked(listVclusterNamespaces)
const mockRemove = vi.mocked(removeSessionVcluster)
const mockWait = vi.mocked(waitForVclusterKubeconfig)

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
