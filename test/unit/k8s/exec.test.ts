import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@yaac/server/lib/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'test-ns'),
  shellKubectlWithRetry: vi.fn(),
}))

import {
  containerExec,
  execTarget,
  interactiveExecArgs,
  stdinExecArgs,
} from '@yaac/server/lib/k8s/exec'
import { shellKubectlWithRetry } from '@yaac/server/lib/k8s/kubectl'

const mockShell = vi.mocked(shellKubectlWithRetry)

describe('execTarget', () => {
  it('targets the Job so kubectl resolves the pod server-side', () => {
    expect(execTarget('yaac-demo-abc')).toBe('job/yaac-demo-abc')
  })
})

describe('containerExec', () => {
  beforeEach(() => {
    mockShell.mockReset()
    mockShell.mockResolvedValue({ stdout: 'out', stderr: '' })
  })

  it('runs the command tail via kubectl exec against the job', async () => {
    const result = await containerExec('yaac-demo-abc', 'git status')
    expect(result.stdout).toBe('out')
    expect(mockShell).toHaveBeenCalledWith(
      'kubectl exec -n test-ns job/yaac-demo-abc -- git status',
      {},
    )
  })

  it('forwards exec options (retries/timeouts) to the kubectl layer', async () => {
    await containerExec('yaac-demo-abc', 'true', { maxAttempts: 1, timeout: 3000 })
    expect(mockShell).toHaveBeenCalledWith(
      expect.stringContaining('-- true'),
      { maxAttempts: 1, timeout: 3000 },
    )
  })

  it('propagates failures', async () => {
    mockShell.mockRejectedValue(new Error('exec died'))
    await expect(containerExec('yaac-demo-abc', 'false')).rejects.toThrow('exec died')
  })
})

describe('interactiveExecArgs', () => {
  it('builds a -it argv with the command after --', () => {
    expect(interactiveExecArgs('yaac-demo-abc', ['tmux', 'attach'])).toEqual([
      'exec', '-n', 'test-ns', '-it', 'job/yaac-demo-abc', '--', 'tmux', 'attach',
    ])
  })
})

describe('stdinExecArgs', () => {
  it('builds a -i (no TTY) argv for stdin-piped relays', () => {
    expect(stdinExecArgs('yaac-demo-abc', ['nc', 'localhost', '3000'])).toEqual([
      'exec', '-n', 'test-ns', '-i', 'job/yaac-demo-abc', '--', 'nc', 'localhost', '3000',
    ])
  })
})
