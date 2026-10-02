import { describe, it, expect, vi } from 'vitest'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'

vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  kubectlWithRetry: vi.fn(),
}))

import { waitForRollout } from '#drivers/k8s/substrate'
import { kubectlWithRetry } from '#drivers/k8s/substrate/kubectl'

const mockKubectl = vi.mocked(kubectlWithRetry)

describe('waitForRollout', () => {
  it('waits on the workload with kubectl, giving the process room past its own timeout', async () => {
    mockKubectl.mockResolvedValue({ stdout: '', stderr: '' })
    await waitForRollout({ workload: 'daemonset/yaac-netd', namespace: 'ns', timeoutMs: 180_000 })
    expect(mockKubectl).toHaveBeenCalledWith(
      ['rollout', 'status', 'daemonset/yaac-netd', '-n', 'ns', '--timeout=180s'],
      { timeout: 190_000, maxAttempts: 2 },
    )
  })

  // kubectl only says it timed out, so the caller's hint says where to look.
  it('adds the hint to a failure, and passes one through untouched without', async () => {
    mockKubectl.mockRejectedValue(new Error('timed out waiting for the condition'))
    await expect(waitForRollout({
      workload: 'deployment/x', namespace: 'ns', timeoutMs: 1_000, hint: 'Inspect the PVC.',
    })).rejects.toThrow('timed out waiting for the condition\nInspect the PVC.')
    await expect(waitForRollout({ workload: 'deployment/x', namespace: 'ns', timeoutMs: 1_000 }))
      .rejects.toThrow(/^timed out waiting for the condition$/)
  })
})
