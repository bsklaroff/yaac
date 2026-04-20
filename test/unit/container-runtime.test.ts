import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock node:child_process so the promisified execFile is controllable.
// Must be hoisted before importing the module under test.
type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const execFileMock = vi.fn<(file: string, args: readonly string[]) => Promise<ExecResult>>()
vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: readonly string[],
    opts: unknown,
    cb?: ExecCallback,
  ) => {
    // When promisify wraps this, it invokes with a callback as the last arg.
    // Our mock looks at the call record to decide whether to succeed or fail.
    const actualCb = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void execFileMock(file, args).then(
      (res) => actualCb(null, res),
      (err: unknown) => actualCb(err),
    )
  },
}))

// Mock dockerode so createAndStartContainerWithRetry can be exercised without
// talking to a real podman socket. The mocked podman instance exposes
// createContainer and getContainer; tests install behaviour via the mocks.
const createContainerMock = vi.fn<(opts: unknown) => Promise<unknown>>()
const getContainerMock = vi.fn<(name: string) => unknown>()
vi.mock('dockerode', () => {
  return {
    default: class FakeDocker {
      createContainer(opts: unknown): Promise<unknown> { return createContainerMock(opts) }
      getContainer(name: string): unknown { return getContainerMock(name) }
    },
  }
})

import {
  isTransientPodmanError,
  podmanExecWithRetry,
  createAndStartContainerWithRetry,
} from '@/lib/container/runtime'

describe('isTransientPodmanError', () => {
  it('matches container-state transitions', () => {
    expect(isTransientPodmanError('container state improper')).toBe(true)
  })

  it('matches brief "no such container" windows', () => {
    expect(isTransientPodmanError('Error: no such container')).toBe(true)
  })

  it('matches OCI runtime exit-file races', () => {
    expect(isTransientPodmanError('timed out waiting for file')).toBe(true)
  })

  it('matches conmon death', () => {
    expect(isTransientPodmanError('conmon exited prematurely')).toBe(true)
  })

  it('matches OCI runtime errors generally', () => {
    expect(isTransientPodmanError('OCI runtime error')).toBe(true)
  })

  it('matches exit-code retrieval failures', () => {
    expect(isTransientPodmanError('error getting exit code')).toBe(true)
  })

  it('matches podman socket refusal', () => {
    expect(isTransientPodmanError('connection refused')).toBe(true)
  })

  it('matches EAGAIN under process pressure (lowercase)', () => {
    expect(isTransientPodmanError('fork/exec /usr/bin/conmon: resource temporarily unavailable')).toBe(true)
  })

  it('matches EAGAIN under process pressure (capitalized, from Go)', () => {
    expect(isTransientPodmanError('crun: cannot fork: Resource temporarily unavailable: OCI runtime error')).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isTransientPodmanError('permission denied')).toBe(false)
    expect(isTransientPodmanError('image not found')).toBe(false)
    expect(isTransientPodmanError('')).toBe(false)
  })
})

describe('podmanExecWithRetry', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  it('returns stdout/stderr on first successful call', async () => {
    execFileMock.mockResolvedValue({ stdout: 'ok', stderr: '' })
    const result = await podmanExecWithRetry(['version'])
    expect(result.stdout).toBe('ok')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('retries on transient errors and eventually succeeds', async () => {
    const transient = Object.assign(new Error('exec failed'), {
      stderr: 'container state improper',
    })
    execFileMock
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValue({ stdout: 'finally', stderr: '' })
    const result = await podmanExecWithRetry(['exec', 'c', 'true'], {
      baseDelay: 1,
      maxAttempts: 5,
    })
    expect(result.stdout).toBe('finally')
    expect(execFileMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry on non-transient errors', async () => {
    const fatal = Object.assign(new Error('fatal'), {
      stderr: 'permission denied',
    })
    execFileMock.mockRejectedValue(fatal)
    await expect(
      podmanExecWithRetry(['exec', 'c', 'true'], { baseDelay: 1, maxAttempts: 5 }),
    ).rejects.toThrow('fatal')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('throws after maxAttempts even if errors remain transient', async () => {
    const transient = Object.assign(new Error('still transient'), {
      stderr: 'OCI runtime error',
    })
    execFileMock.mockRejectedValue(transient)
    await expect(
      podmanExecWithRetry(['exec', 'c', 'true'], { baseDelay: 1, maxAttempts: 3 }),
    ).rejects.toThrow('still transient')
    expect(execFileMock).toHaveBeenCalledTimes(3)
  })
})

describe('createAndStartContainerWithRetry', () => {
  beforeEach(() => {
    createContainerMock.mockReset()
    getContainerMock.mockReset()
  })

  it('returns the container on first-attempt success', async () => {
    const start = vi.fn().mockResolvedValue(undefined)
    const container = { start, remove: vi.fn() }
    createContainerMock.mockResolvedValue(container)

    const result = await createAndStartContainerWithRetry({ name: 'c' })

    expect(result).toBe(container)
    expect(createContainerMock).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('retries on transient start failures and cleans up the stale container', async () => {
    const start1 = vi.fn().mockRejectedValue(
      new Error('crun: mount devpts to dev/pts: Invalid argument: OCI runtime error'),
    )
    const remove1 = vi.fn().mockResolvedValue(undefined)
    const start2 = vi.fn().mockResolvedValue(undefined)
    const remove2 = vi.fn()

    createContainerMock
      .mockResolvedValueOnce({ start: start1, remove: remove1 })
      .mockResolvedValueOnce({ start: start2, remove: remove2 })

    const result = await createAndStartContainerWithRetry(
      { name: 'c' },
      { baseDelay: 1, maxAttempts: 3 },
    )

    expect(start1).toHaveBeenCalledTimes(1)
    expect(remove1).toHaveBeenCalledWith({ force: true })
    expect(start2).toHaveBeenCalledTimes(1)
    expect(createContainerMock).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ start: start2, remove: remove2 })
  })

  it('retries on transient createContainer failures and removes the name conflict', async () => {
    const transient = new Error('OCI runtime error: container state improper')
    const stale = { remove: vi.fn().mockResolvedValue(undefined) }
    getContainerMock.mockReturnValue(stale)

    const start = vi.fn().mockResolvedValue(undefined)
    createContainerMock
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ start, remove: vi.fn() })

    await createAndStartContainerWithRetry(
      { name: 'c' },
      { baseDelay: 1, maxAttempts: 3 },
    )

    expect(getContainerMock).toHaveBeenCalledWith('c')
    expect(stale.remove).toHaveBeenCalledWith({ force: true })
    expect(createContainerMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry on non-transient errors', async () => {
    createContainerMock.mockRejectedValue(new Error('image not found'))

    await expect(
      createAndStartContainerWithRetry({ name: 'c' }, { baseDelay: 1, maxAttempts: 5 }),
    ).rejects.toThrow('image not found')
    expect(createContainerMock).toHaveBeenCalledTimes(1)
  })

  it('throws after maxAttempts when errors remain transient', async () => {
    const transient = new Error('OCI runtime error')
    createContainerMock.mockRejectedValue(transient)

    await expect(
      createAndStartContainerWithRetry({ name: 'c' }, { baseDelay: 1, maxAttempts: 2 }),
    ).rejects.toThrow('OCI runtime error')
    expect(createContainerMock).toHaveBeenCalledTimes(2)
  })
})
