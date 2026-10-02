import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('@yaac/server/drivers/k8s/install/check', () => ({
  runClusterCheck: vi.fn(),
} satisfies Partial<typeof clusterCheckModule>))

import { clusterCheck } from '#commands/cluster-check'
import { runClusterCheck } from '@yaac/server/drivers/k8s/install/check'
import type * as clusterCheckModule from '@yaac/server/drivers/k8s/install/check'

const mockRun = vi.mocked(runClusterCheck)

describe('clusterCheck (CLI)', () => {
  let logSpy: MockInstance<typeof console.log>
  let errSpy: MockInstance<typeof console.error>

  beforeEach(() => {
    mockRun.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    errSpy.mockRestore()
  })

  it('prints every formatted result and a ready message on success', async () => {
    mockRun.mockResolvedValue({
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
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('prints every result, then throws the failure footer when not ok', async () => {
    mockRun.mockResolvedValue({
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
