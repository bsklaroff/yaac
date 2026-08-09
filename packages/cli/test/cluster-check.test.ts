import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('@yaac/server/features/cluster/check', () => ({
  runClusterCheck: vi.fn(),
  formatCheckResult: vi.fn(
    (r: { name: string; status: string }) => `[${r.status}] ${r.name}`,
  ),
} satisfies Partial<typeof clusterCheckModule>))

import { clusterCheck } from '#commands/cluster-check'
import { formatCheckResult, runClusterCheck } from '@yaac/server/features/cluster/check'
import type * as clusterCheckModule from '@yaac/server/features/cluster/check'

const mockRun = vi.mocked(runClusterCheck)
const mockFormat = vi.mocked(formatCheckResult)

describe('clusterCheck (CLI)', () => {
  let logSpy: MockInstance<typeof console.log>
  let errSpy: MockInstance<typeof console.error>

  beforeEach(() => {
    mockRun.mockReset()
    mockFormat.mockClear()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
  })

  afterEach(() => {
    logSpy.mockRestore()
    errSpy.mockRestore()
    process.exitCode = undefined
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

    expect(mockFormat).toHaveBeenCalledTimes(2)
    const logged = logSpy.mock.calls.map((c) => c[0] as unknown)
    expect(logged).toContain('[pass] kubectl')
    expect(logged).toContain('[pass] cluster')
    expect(logged).toContain('\nCluster is ready for yaac worktrees.')
    expect(errSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('prints the failure footer and sets exit code 1 when not ok', async () => {
    mockRun.mockResolvedValue({
      ok: false,
      results: [
        { name: 'kubectl', status: 'pass', detail: 'installed' },
        { name: 'registry', status: 'fail', detail: 'down', fix: 'start it' },
      ],
    })

    await clusterCheck()

    const logged = logSpy.mock.calls.map((c) => c[0] as unknown)
    expect(logged).toContain('[fail] registry')
    expect(errSpy).toHaveBeenCalledWith(
      '\nCluster is not ready for yaac worktrees. Fix the failures above and re-run.',
    )
    expect(process.exitCode).toBe(1)
  })
})
