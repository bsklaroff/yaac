import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  exec: vi.fn(),
}))

vi.mock('@/lib/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'test-ns'),
  shellKubectlWithRetry: vi.fn(),
}))

import {
  attachTmux,
  containerExec,
  execTarget,
  interactiveExecArgs,
  runInteractiveExec,
  stdinExecArgs,
} from '@/lib/k8s/exec'
import { shellKubectlWithRetry } from '@/lib/k8s/kubectl'

const mockShell = vi.mocked(shellKubectlWithRetry)
const mockSpawn = vi.mocked(spawn)

/** Fake kubectl child that emits the given event on the next tick. */
function fakeChild(event: 'close' | 'error', arg: unknown): EventEmitter {
  const child = new EventEmitter()
  process.nextTick(() => child.emit(event, arg))
  return child
}

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

describe('runInteractiveExec', () => {
  beforeEach(() => {
    mockSpawn.mockReset()
  })

  it('spawns kubectl with the interactive argv and an inherited tty', async () => {
    mockSpawn.mockImplementation(() => fakeChild('close', 0) as never)

    await runInteractiveExec('yaac-demo-abc', ['zsh'])

    expect(mockSpawn).toHaveBeenCalledWith(
      'kubectl',
      ['exec', '-n', 'test-ns', '-it', 'job/yaac-demo-abc', '--', 'zsh'],
      { stdio: 'inherit' },
    )
  })

  it('resolves on close regardless of exit code (detach and kill look alike)', async () => {
    mockSpawn.mockImplementation(() => fakeChild('close', 137) as never)
    await expect(runInteractiveExec('yaac-demo-abc', ['zsh'])).resolves.toBeUndefined()
  })

  it('rejects when kubectl itself cannot be spawned', async () => {
    mockSpawn.mockImplementation(() => fakeChild('error', new Error('ENOENT')) as never)
    await expect(runInteractiveExec('yaac-demo-abc', ['zsh'])).rejects.toThrow('ENOENT')
  })
})

describe('attachTmux', () => {
  it('attaches to the tmux session via the container tmux socket', async () => {
    mockSpawn.mockReset()
    mockSpawn.mockImplementation(() => fakeChild('close', 0) as never)

    await attachTmux('yaac-demo-abc', 'yaac')

    expect(mockSpawn).toHaveBeenCalledWith(
      'kubectl',
      [
        'exec', '-n', 'test-ns', '-it', 'job/yaac-demo-abc', '--',
        'tmux', '-S', '/tmp/yaac-tmux/server', 'attach-session', '-t', 'yaac',
      ],
      { stdio: 'inherit' },
    )
  })
})

describe('stdinExecArgs', () => {
  it('builds a -i (no TTY) argv for stdin-piped relays', () => {
    expect(stdinExecArgs('yaac-demo-abc', ['nc', 'localhost', '3000'])).toEqual([
      'exec', '-n', 'test-ns', '-i', 'job/yaac-demo-abc', '--', 'nc', 'localhost', '3000',
    ])
  })
})
