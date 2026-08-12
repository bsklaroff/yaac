import { describe, it, expect, vi, beforeEach } from 'vitest'

// The folder's process boundary is the kubectl child process, so the shell
// runner and its transient-error retries run for real underneath.
type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const execMock = vi.fn<(command: string) => Promise<ExecResult>>()
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  exec: (command: string, opts: unknown, cb?: ExecCallback) => {
    const actualCb = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void execMock(command).then(
      (res) => actualCb(null, res),
      (err: unknown) => actualCb(err),
    )
  },
}))

import { containerExec } from '#runtime/k8s/substrate'

function stderrError(stderr: string): Error {
  return Object.assign(new Error('kubectl failed'), { stderr })
}

describe('containerExec', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    execMock.mockReset()
    execMock.mockResolvedValue({ stdout: 'out', stderr: '' })
  })

  it('runs the command tail against the Job, which resolves the pod server-side', async () => {
    vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
    const result = await containerExec('yaac-demo-abc', 'git status')
    expect(result).toEqual({ stdout: 'out', stderr: '' })
    expect(execMock).toHaveBeenCalledWith('kubectl exec -n test-ns job/yaac-demo-abc -- git status')
  })

  it('retries transient exec failures — a pod being replaced 404s the subresource', async () => {
    execMock
      .mockRejectedValueOnce(stderrError('unable to upgrade connection: pod does not exist'))
      .mockResolvedValue({ stdout: 'finally', stderr: '' })
    const result = await containerExec('yaac-demo-abc', 'true', { baseDelay: 1, maxAttempts: 3 })
    expect(result.stdout).toBe('finally')
    expect(execMock).toHaveBeenCalledTimes(2)
  })

  it('propagates a permanent failure on the first attempt', async () => {
    execMock.mockRejectedValue(stderrError('permission denied'))
    await expect(containerExec('yaac-demo-abc', 'false', { baseDelay: 1, maxAttempts: 3 }))
      .rejects.toThrow('kubectl failed')
    expect(execMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after maxAttempts, and forwards the caller timeout', async () => {
    execMock.mockRejectedValue(new Error('net dial: i/o timeout'))
    await expect(containerExec('yaac-demo-abc', 'true', { maxAttempts: 2, baseDelay: 1, timeout: 3000 }))
      .rejects.toThrow(/i\/o timeout/)
    expect(execMock).toHaveBeenCalledTimes(2)
  })
})
