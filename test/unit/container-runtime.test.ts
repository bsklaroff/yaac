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
    const actualCb = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void execFileMock(file, args).then(
      (res) => actualCb(null, res),
      (err: unknown) => actualCb(err),
    )
  },
  spawn: vi.fn(() => ({ unref: () => {}, on: () => {} })),
}))

// The session runtime half of ensureContainerRuntime — mocked so this file
// never needs a cluster. ensureKubernetes itself is covered in
// test/unit/k8s/kubectl.test.ts.
vi.mock('@/lib/k8s/kubectl', () => ({
  ensureKubernetes: vi.fn().mockResolvedValue(undefined),
}))

import {
  ensureContainerRuntime,
  execFileAsync,
  getSocketPath,
  imageExists,
  removeImage,
} from '@/lib/container/runtime'
import { ensureKubernetes } from '@/lib/k8s/kubectl'

// ensurePodmanSocket is exercised against real sockets in
// test/unit/ensure-podman-socket.test.ts — not duplicated here.

describe('execFileAsync', () => {
  it('is the promisified execFile export', () => {
    expect(typeof execFileAsync).toBe('function')
  })
})

describe('getSocketPath', () => {
  it('returns the rootless podman socket path for the current uid on linux', () => {
    if (process.platform === 'darwin') {
      expect(getSocketPath()).toBeUndefined()
      return
    }
    const uid = process.getuid?.()
    expect(getSocketPath()).toBe(`/run/user/${uid}/podman/podman.sock`)
  })
})

describe('ensureContainerRuntime', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    vi.mocked(ensureKubernetes).mockClear()
  })

  it('verifies the podman build engine, then the kubernetes session runtime', async () => {
    // `podman info --format json` (linux) / `podman machine list` (darwin)
    // both succeed via the same mock.
    execFileMock.mockResolvedValue({ stdout: '[{"Running": true}]', stderr: '' })

    await ensureContainerRuntime()

    expect(execFileMock).toHaveBeenCalledWith('podman', expect.arrayContaining(
      process.platform === 'darwin' ? ['machine', 'list'] : ['info'],
    ))
    expect(ensureKubernetes).toHaveBeenCalledTimes(1)
  })

  it('propagates kubernetes failures after the podman check passes', async () => {
    execFileMock.mockResolvedValue({ stdout: '[{"Running": true}]', stderr: '' })
    vi.mocked(ensureKubernetes).mockRejectedValueOnce(
      new Error('Kubernetes cluster is not reachable.'),
    )
    await expect(ensureContainerRuntime()).rejects.toThrow('not reachable')
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

describe('removeImage', () => {
  beforeEach(() => { execFileMock.mockReset() })

  it('calls podman rmi -f with the tag', async () => {
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' })
    await removeImage('yaac-tools:abc')
    expect(execFileMock).toHaveBeenCalledWith('podman', ['rmi', '-f', 'yaac-tools:abc'])
  })

  it('swallows errors so missing/in-use images do not abort cleanup', async () => {
    execFileMock.mockRejectedValue(new Error('image is in use'))
    await expect(removeImage('busy:tag')).resolves.toBeUndefined()
  })
})
