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
  spawn: vi.fn(() => ({ unref: () => {}, on: () => {} })),
}))

// This folder's registry module reaches `#platform/k8s` for its
// port-forward, which pulls kubectl's own promisified child_process in.
// Stubbed so the mock above (which has no `exec`) is not asked to serve it.
vi.mock('#platform/k8s/kubectl', () => ({
  ensureKubernetes: vi.fn().mockResolvedValue(undefined),
}))

import {
  ensureHostPodman,
  ensureRootfulPodmanHost,
  execFileAsync,
  imageExists,
  removeImage,
  ROOTFUL_PODMAN_SOCKET,
} from '#platform/container'

const realPlatform = process.platform
const realHost = process.env.CONTAINER_HOST

/**
 * Both podman halves are chosen by platform — the macOS machine check and
 * the Linux rootful-socket check — so the platform is an argument here, not
 * a property of the box the suite happens to run on.
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

describe('ensureHostPodman', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    delete process.env.CONTAINER_HOST
  })

  it('checks the rootful podman engine on linux', async () => {
    setPlatform('linux')
    execFileMock.mockResolvedValue({ stdout: '{}', stderr: '' })

    await ensureHostPodman()

    expect(execFileMock).toHaveBeenCalledWith('podman', ['info', '--format', 'json'])
    // The engine check runs against the rootful socket it just pointed at.
    expect(process.env.CONTAINER_HOST).toBe(`unix://${ROOTFUL_PODMAN_SOCKET}`)
  })

  it('prints install instructions and exits when linux podman is unreachable', async () => {
    setPlatform('linux')
    execFileMock.mockRejectedValue(new Error('dial unix: permission denied'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)

    await expect(ensureHostPodman()).rejects.toThrow('process.exit')

    expect(exit).toHaveBeenCalledWith(1)
    expect(err.mock.calls[0]?.[0]).toContain(`setfacl -m u:$USER:rw ${ROOTFUL_PODMAN_SOCKET}`)
  })

  it('checks the podman machine on darwin', async () => {
    setPlatform('darwin')
    execFileMock.mockResolvedValue({ stdout: '[{"Running": false}, {"Running": true}]', stderr: '' })

    await ensureHostPodman()

    expect(execFileMock).toHaveBeenCalledWith('podman', ['machine', 'list', '--format', 'json'])
    // macOS drives the machine, so nothing points CONTAINER_HOST anywhere.
    expect(process.env.CONTAINER_HOST).toBeUndefined()
  })

  it('exits when darwin has podman but no running machine', async () => {
    setPlatform('darwin')
    execFileMock.mockResolvedValue({ stdout: '[{"Running": false}]', stderr: '' })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)

    await expect(ensureHostPodman()).rejects.toThrow('process.exit')

    expect(exit).toHaveBeenCalledWith(1)
    expect(err.mock.calls[0]?.[0]).toContain('podman machine start')
  })

  it('exits with brew instructions when darwin has no podman at all', async () => {
    setPlatform('darwin')
    execFileMock.mockRejectedValue(new Error('podman: command not found'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)

    await expect(ensureHostPodman()).rejects.toThrow('process.exit')

    expect(err.mock.calls[0]?.[0]).toContain('brew install podman')
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
