import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import type * as installModule from '@yaac/server/drivers/k8s/install'

// The install feature is the CLI's door to the cluster and the host's
// podman, so its steps are faked; the flag checks run for real.
vi.mock('@yaac/server/drivers/k8s/install', async (importOriginal) => ({
  ...await importOriginal<typeof installModule>(),
  foreignClusterRefusal: vi.fn().mockResolvedValue(null),
  runClusterInstall: vi.fn(),
  runClusterCheck: vi.fn(),
}))

import { clusterCheck, clusterInstall } from '#commands/cluster'
import { runClusterCheck, runClusterInstall } from '@yaac/server/drivers/k8s/install'

const mockRun = vi.mocked(runClusterInstall)
const mockCheck = vi.mocked(runClusterCheck)
let tmpDir: string
let logSpy: MockInstance<typeof console.log>

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockRun.mockReset().mockResolvedValue(undefined)
  mockCheck.mockReset().mockResolvedValue({ ok: true, results: [] })
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  process.exitCode = undefined
})

afterEach(async () => {
  logSpy.mockRestore()
  process.exitCode = undefined
  await cleanupTempDir(tmpDir)
})

describe('clusterCheck', () => {
  it('prints every formatted result and a ready message on success', async () => {
    mockCheck.mockResolvedValue({
      ok: true,
      results: [
        { name: 'kubectl', status: 'pass', detail: 'installed' },
        { name: 'cluster', status: 'pass', detail: 'reachable' },
      ],
    })

    await clusterCheck()

    const logged = logSpy.mock.calls.map((c) => c[0] as unknown)
    expect(logged).toContain('✓ kubectl: installed')
    expect(logged).toContain('✓ cluster: reachable')
    expect(logged).toContain('\nCluster is ready for yaac workspaces.')
  })

  it('prints every result, then throws the failure footer when not ok', async () => {
    mockCheck.mockResolvedValue({
      ok: false,
      results: [
        { name: 'kubectl', status: 'pass', detail: 'installed' },
        { name: 'registry', status: 'fail', detail: 'down', fix: 'start it' },
      ],
    })

    await expect(clusterCheck()).rejects.toThrow(
      '\nCluster is not ready for yaac workspaces. Fix the failures above and re-run.',
    )

    const logged = logSpy.mock.calls.map((c) => c[0] as unknown)
    expect(logged).toContain('✗ registry: down\n    fix: start it')
  })
})

describe('clusterInstall', () => {
  it('passes the flags through as typed, then verifies with a passing check', async () => {
    const options = { byo: true, rwxStorageClass: 'nfs', rwoStorageClass: 'ssd', tailnet: true }
    await clusterInstall(options)
    expect(mockRun).toHaveBeenCalledWith(options)
    expect(mockCheck.mock.invocationCallOrder[0]).toBeGreaterThan(mockRun.mock.invocationCallOrder[0])
    expect(process.exitCode).toBeUndefined()
  })

  // The layers are in place either way, so a failed egress gate gets its
  // own warning: the cluster looks usable but does not enforce the policy.
  it.each([
    ['another gate', 'probe', false],
    ['the egress gate', 'egress', true],
  ])('exits 1 when %s fails, warning about egress only for egress', async (_case, name, warns) => {
    mockCheck.mockResolvedValue({ ok: false, results: [{ name, status: 'fail', detail: 'x' }] })
    await clusterInstall({})
    expect(process.exitCode).toBe(1)
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(printed).toContain('Cluster is not ready')
    expect(printed.includes('egress gate FAILED')).toBe(warns)
  })

  it('propagates a failed install step without running the check', async () => {
    mockRun.mockRejectedValue(new Error('install kind first'))
    await expect(clusterInstall({})).rejects.toThrow('install kind first')
    expect(mockCheck).not.toHaveBeenCalled()
  })

  it('rejects a flag error before any install step runs', async () => {
    await expect(clusterInstall({ rwxStorageClass: 'nfs' })).rejects.toThrow(/for --byo only/)
    expect(mockRun).not.toHaveBeenCalled()
  })
})
