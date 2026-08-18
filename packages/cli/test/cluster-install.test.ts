import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('@yaac/server/drivers/k8s/install', () => {
  class ClusterInstallError extends Error {}
  return { runClusterInstall: vi.fn(), ClusterInstallError } satisfies Partial<typeof installModule>
})

import { clusterInstall } from '#commands/cluster-install'
import { ClusterInstallError, runClusterInstall } from '@yaac/server/drivers/k8s/install'
import type * as installModule from '@yaac/server/drivers/k8s/install'

const mockRun = vi.mocked(runClusterInstall)

describe('clusterInstall (CLI)', () => {
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

  it('passes the flags through as typed and exits clean on success', async () => {
    mockRun.mockResolvedValue(true)
    // --nodes stays raw text: the command owns the bounds, and converting
    // here would make a bad value report `NaN` instead of what was typed.
    await clusterInstall({ nodes: '3', adoptCni: true })
    expect(mockRun).toHaveBeenCalledWith({ nodes: '3', adoptCni: true })
    expect(process.exitCode).toBeUndefined()
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('sets exit code 1 when the finishing check reports not-ok', async () => {
    mockRun.mockResolvedValue(false)
    await clusterInstall()
    expect(process.exitCode).toBe(1)
  })

  it('prints ClusterInstallError messages to stderr and exits 1', async () => {
    mockRun.mockRejectedValue(new ClusterInstallError('install kind first'))
    await clusterInstall({})
    expect(errSpy).toHaveBeenCalledWith('\ninstall kind first')
    expect(process.exitCode).toBe(1)
  })

  it('rethrows unexpected errors', async () => {
    mockRun.mockRejectedValue(new Error('boom'))
    await expect(clusterInstall({})).rejects.toThrow('boom')
  })
})
