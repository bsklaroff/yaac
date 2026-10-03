import { describe, it, expect, vi, beforeEach } from 'vitest'

// Only the kubectl child process is faked, so the shell runner runs for
// real.
type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const execMock = vi.fn<(command: string, opts: unknown) => Promise<ExecResult>>()
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  exec: (command: string, opts: unknown, cb?: ExecCallback) => {
    const actualCb = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void execMock(command, typeof opts === 'function' ? undefined : opts).then(
      (res) => actualCb(null, res),
      (err: unknown) => actualCb(err),
    )
  },
}))

import { containerExec } from '#drivers/k8s/substrate'

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
    expect(execMock).toHaveBeenCalledWith(
      'kubectl exec -n test-ns job/yaac-demo-abc -- git status',
      expect.objectContaining({ maxBuffer: 64 << 20 }),
    )
  })

  it('fails on the first error, forwarding the caller timeout', async () => {
    execMock.mockRejectedValue(stderrError('unable to upgrade connection: pod does not exist'))
    await expect(containerExec('yaac-demo-abc', 'true', { timeout: 3000 })).rejects.toThrow('kubectl failed')
    expect(execMock).toHaveBeenCalledTimes(1)
    expect(execMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ timeout: 3000 }))
  })
})
