import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('@yaac/server/drivers/k8s/install', () => ({
  runClusterInstall: vi.fn(),
  runClusterCheck: vi.fn(),
} satisfies Partial<typeof installModule>))

import { clusterInstall } from '#commands/cluster-install'
import { runClusterCheck, runClusterInstall } from '@yaac/server/drivers/k8s/install'
import type * as installModule from '@yaac/server/drivers/k8s/install'

const mockRun = vi.mocked(runClusterInstall)
const mockCheck = vi.mocked(runClusterCheck)

describe('clusterInstall (CLI)', () => {
  let logSpy: MockInstance<typeof console.log>

  beforeEach(() => {
    mockRun.mockReset().mockResolvedValue(undefined)
    mockCheck.mockReset().mockResolvedValue({ ok: true, results: [] })
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    process.exitCode = undefined
  })

  afterEach(() => {
    logSpy.mockRestore()
    process.exitCode = undefined
  })

  it('passes the flags through as typed, then verifies with a passing check', async () => {
    // --nodes stays a string so install reports what the user typed.
    const options = { nodes: '3', byo: true, rwxStorageClass: 'nfs', rwoStorageClass: 'ssd', tailnet: true }
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
})
