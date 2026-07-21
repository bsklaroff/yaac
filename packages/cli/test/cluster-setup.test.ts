import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('@yaac/server/features/cluster/setup', () => {
  class ClusterSetupError extends Error {}
  return { runClusterSetup: vi.fn(), ClusterSetupError } satisfies Partial<typeof clusterSetupModule>
})

import { clusterSetup } from '#commands/cluster-setup'
import { ClusterSetupError, runClusterSetup } from '@yaac/server/features/cluster/setup'
import type * as clusterSetupModule from '@yaac/server/features/cluster/setup'

const mockRun = vi.mocked(runClusterSetup)

describe('clusterSetup (CLI)', () => {
  let errSpy: MockInstance<typeof console.error>

  beforeEach(() => {
    mockRun.mockReset()
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
  })

  afterEach(() => {
    errSpy.mockRestore()
    process.exitCode = undefined
  })

  it('passes the --repair flag through and exits clean on success', async () => {
    mockRun.mockResolvedValue(true)
    await clusterSetup({ repair: true })
    expect(mockRun).toHaveBeenCalledWith({ repair: true })
    expect(process.exitCode).toBeUndefined()
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('sets exit code 1 when the finishing check reports not-ok', async () => {
    mockRun.mockResolvedValue(false)
    await clusterSetup({})
    expect(process.exitCode).toBe(1)
  })

  it('prints ClusterSetupError messages to stderr and exits 1', async () => {
    mockRun.mockRejectedValue(new ClusterSetupError('install kind first'))
    await clusterSetup({})
    expect(errSpy).toHaveBeenCalledWith('\ninstall kind first')
    expect(process.exitCode).toBe(1)
  })

  it('rethrows unexpected errors', async () => {
    mockRun.mockRejectedValue(new Error('boom'))
    await expect(clusterSetup({})).rejects.toThrow('boom')
  })
})
