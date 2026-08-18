import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('@yaac/server/drivers/k8s/install', () => {
  class ClusterDeleteError extends Error {}
  return { runClusterDelete: vi.fn(), ClusterDeleteError } satisfies Partial<typeof clusterDeleteModule>
})

import { clusterDelete } from '#commands/cluster-delete'
import { ClusterDeleteError, runClusterDelete } from '@yaac/server/drivers/k8s/install'
import type * as clusterDeleteModule from '@yaac/server/drivers/k8s/install'

const mockRun = vi.mocked(runClusterDelete)

describe('clusterDelete (CLI)', () => {
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

  it('passes the --yes flag through and exits clean on success', async () => {
    mockRun.mockResolvedValue(undefined)
    await clusterDelete({ yes: true })
    expect(mockRun).toHaveBeenCalledWith({ yes: true })
    expect(process.exitCode).toBeUndefined()
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('defaults yes to undefined when no options are given', async () => {
    mockRun.mockResolvedValue(undefined)
    await clusterDelete()
    expect(mockRun).toHaveBeenCalledWith({ yes: undefined })
  })

  it('prints ClusterDeleteError messages to stderr and exits 1', async () => {
    mockRun.mockRejectedValue(new ClusterDeleteError('cluster is external infrastructure'))
    await clusterDelete({})
    expect(errSpy).toHaveBeenCalledWith('\ncluster is external infrastructure')
    expect(process.exitCode).toBe(1)
  })

  it('rethrows unexpected errors', async () => {
    mockRun.mockRejectedValue(new Error('boom'))
    await expect(clusterDelete({})).rejects.toThrow('boom')
  })
})
