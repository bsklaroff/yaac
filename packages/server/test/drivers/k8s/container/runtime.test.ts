import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The one process boundary this half of the folder has: every podman call
// goes through the promisified execFile. Mocking node:child_process (rather
// than execFileAsync, which is itself part of the interface) keeps the
// promisify wrapper in the test's path. Hoisted before the module import.
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
    const actualCb = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void execFileMock(file, args).then(
      (res) => actualCb(null, res),
      (err: unknown) => actualCb(err),
    )
  },
  // Unused here, but the container barrel pulls in modules that promisify
  // it at import time.
  exec: (_cmd: string, _opts: unknown, cb?: ExecCallback) => { cb?.(null, { stdout: '', stderr: '' }) },
  spawn: vi.fn(() => ({ unref: () => {}, on: () => {} })),
}))

import {
  ensureRootfulPodmanHost,
  execFileAsync,
  imageExists,
} from '#drivers/k8s/container'

const realPlatform = process.platform
const realHost = process.env.CONTAINER_HOST

/**
 * The rootful lever is chosen by platform, so the platform is an argument
 * here rather than a property of the box the suite happens to run on.
 */
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

afterEach(() => {
  setPlatform(realPlatform)
  if (realHost === undefined) delete process.env.CONTAINER_HOST
  else process.env.CONTAINER_HOST = realHost
  vi.restoreAllMocks()
})

describe('execFileAsync', () => {
  beforeEach(() => { execFileMock.mockReset() })

  it('resolves the child stdout and rejects on a failed spawn', async () => {
    execFileMock.mockResolvedValue({ stdout: 'sha256:abc\n', stderr: '' })
    await expect(execFileAsync('podman', ['image', 'ls', '-q'])).resolves.toMatchObject({
      stdout: 'sha256:abc\n',
    })

    execFileMock.mockRejectedValue(new Error('podman: not found'))
    await expect(execFileAsync('podman', ['image', 'ls'])).rejects.toThrow('not found')
  })
})

describe('ensureRootfulPodmanHost', () => {
  beforeEach(() => { delete process.env.CONTAINER_HOST })

  it('points CONTAINER_HOST at the rootful socket on linux', () => {
    setPlatform('linux')
    ensureRootfulPodmanHost()
    expect(process.env.CONTAINER_HOST).toBe('unix:///run/podman/podman.sock')
  })

  it('honours a CONTAINER_HOST the caller already set', () => {
    setPlatform('linux')
    process.env.CONTAINER_HOST = 'unix:///custom.sock'
    ensureRootfulPodmanHost()
    expect(process.env.CONTAINER_HOST).toBe('unix:///custom.sock')
  })

  it('is a no-op on darwin, where podman machine owns the connection', () => {
    setPlatform('darwin')
    ensureRootfulPodmanHost()
    expect(process.env.CONTAINER_HOST).toBeUndefined()
  })
})

describe('imageExists', () => {
  beforeEach(() => { execFileMock.mockReset() })

  it('returns true when podman image inspect succeeds', async () => {
    execFileMock.mockResolvedValue({ stdout: '[]', stderr: '' })
    expect(await imageExists('yaac-tools:abc')).toBe(true)
    expect(execFileMock).toHaveBeenCalledWith('podman', ['image', 'inspect', 'yaac-tools:abc'])
  })

  it('returns false when inspect fails (image absent)', async () => {
    execFileMock.mockRejectedValue(new Error('no such image'))
    expect(await imageExists('missing:tag')).toBe(false)
  })
})
