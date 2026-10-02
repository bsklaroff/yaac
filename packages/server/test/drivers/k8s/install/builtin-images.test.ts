/**
 * The image part of `yaac cluster install`: what it builds, mirrors and
 * skips. Only podman and the registry client are faked, so real tag
 * resolution runs and the tests assert the tags a workspace create looks up.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as registryModule from '#drivers/k8s/container/registry'
import type * as runtimeModule from '#drivers/k8s/container/runtime'
import type * as hostProcsModule from '#drivers/k8s/container/host-procs'
import type * as childProcessModule from 'node:child_process'


// Several modules promisify their own execFile for podman, so the mock sits
// at node:child_process.
type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const mockExecFile = vi.hoisted(() => vi.fn<(file: string, args: string[]) => Promise<ExecResult>>())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcessModule>()),
  execFile: (file: string, args: string[], opts: unknown, cb?: ExecCallback) => {
    const done = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void mockExecFile(file, args).then((res) => done(null, res), (err: unknown) => done(err))
  },
  spawn: vi.fn(() => ({ unref: () => {}, on: () => {} })),
}))

const mockImageExists = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/container/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof runtimeModule>()),
  imageExists: mockImageExists,
}))

const mockRunTrackedPodman = vi.hoisted(() => vi.fn())
const mockReap = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/container/host-procs', async (importOriginal) => ({
  ...(await importOriginal<typeof hostProcsModule>()),
  runTrackedPodman: mockRunTrackedPodman,
  reapOrphanedPodmanProcs: mockReap,
}))

const mockRegistryHasTag = vi.hoisted(() => vi.fn())
const mockPush = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/container/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof registryModule>()),
  registryHasTag: mockRegistryHasTag,
  registryRef: (tag: string) => `localhost:5001/${tag}`,
  pushImageToRegistry: mockPush,
}))

import { buildBuiltinImages } from '#drivers/k8s/install'
import { resolveTrustedLayers } from '#drivers/k8s/image-engine'
// Setup values, not units under test.
import { TRUSTED_PARENT_COMPRESSION } from '#drivers/k8s/install/builtin-images'
import { BUILDER_LOCAL_TAG } from '#drivers/k8s/cluster/builder-image'

/** The tag of every `podman build` this run performed, in order. */
const built = (): string[] =>
  (mockRunTrackedPodman.mock.calls as Array<[string[], { tag: string }]>)
    .filter(([args]) => args[0] === 'build')
    .map(([, opts]) => opts.tag)

const pushed = (): string[] =>
  (mockPush.mock.calls as Array<[string, unknown]>).map(([tag]) => tag)

beforeEach(() => {
  vi.clearAllMocks()
  mockExecFile.mockResolvedValue({ stdout: '', stderr: '' })
  mockRunTrackedPodman.mockResolvedValue(undefined)
  mockReap.mockResolvedValue(undefined)
  mockPush.mockImplementation((tag: string) => Promise.resolve(`localhost:5001/${tag}`))
  mockImageExists.mockResolvedValue(false)
  mockRegistryHasTag.mockResolvedValue(false)
})

describe('buildBuiltinImages', () => {
  it('builds the whole trusted chain and pushes it under the tags a create looks up', async () => {
    await buildBuiltinImages({ log: vi.fn() })

    // The tags a create looks up, derived from content alone.
    const { base, tools, nestable } = await resolveTrustedLayers('yaac')
    // In dependency order: each layer is the next one's FROM.
    expect(built().slice(0, 3)).toEqual([base.tag, tools.tag, nestable.tag])
    // Pushed with zstd, since builder pods pull these as parents.
    for (const layer of [base, tools, nestable]) {
      expect(mockPush).toHaveBeenCalledWith(
        layer.tag, { compressionFormat: TRUSTED_PARENT_COMPRESSION },
      )
    }
  })

  it('builds the proxy and netd images, and mirrors every pinned upstream', async () => {
    await buildBuiltinImages({ log: vi.fn() })

    // The other yaac-built images, also content-hash tagged.
    expect(built().some((t) => t.startsWith('yaac-proxy:'))).toBe(true)
    expect(built().some((t) => t.startsWith('yaac-netd:'))).toBe(true)
    // Digest-pinned upstreams are pulled, retagged and pushed, so nodes
    // never pull from upstream.
    const pulls = mockExecFile.mock.calls
      .filter(([, a]) => a[0] === 'pull').map(([, a]) => a[1])
    expect(pulls.some((r) => r.includes('library/registry@sha256:'))).toBe(true)
    expect(pulls.some((r) => r.includes('envoyproxy/envoy@sha256:'))).toBe(true)
    expect(pulls.some((r) => r.includes('podman/stable@sha256:'))).toBe(true)
    expect(pulls.some((r) => r.includes('curlimages/curl@sha256:'))).toBe(true)
    const tags = mockExecFile.mock.calls.filter(([, a]) => a[0] === 'tag').map(([, a]) => a[2])
    expect(tags).toContain(BUILDER_LOCAL_TAG)
    expect(pushed()).toContain(BUILDER_LOCAL_TAG)
  })

  it('reaps a previous install\'s orphaned builds before deciding what is missing', async () => {
    await buildBuiltinImages({ log: vi.fn() })
    expect(mockReap).toHaveBeenCalledOnce()
    expect(mockReap.mock.invocationCallOrder[0])
      .toBeLessThan(mockRunTrackedPodman.mock.invocationCallOrder[0])
  })

  it('is a no-op when the registry already holds every tag', async () => {
    // With content-hash tags, re-running install with no changes costs
    // only registry lookups.
    mockRegistryHasTag.mockResolvedValue(true)

    await buildBuiltinImages({ log: vi.fn() })

    expect(built()).toEqual([])
    expect(mockPush).not.toHaveBeenCalled()
    // The mirrors skip on the same check.
    expect(mockExecFile.mock.calls.some(([, a]) => a[0] === 'pull')).toBe(false)
  })

  it('fails the install when a shipped image fails to build', async () => {
    mockRegistryHasTag.mockResolvedValue(false)
    mockRunTrackedPodman.mockImplementation((_args: string[], opts: { tag: string }) =>
      opts.tag.startsWith('yaac-proxy:')
        ? Promise.reject(new Error('podman build exited with code 1'))
        : Promise.resolve(undefined))

    await expect(buildBuiltinImages({ log: vi.fn() }))
      .rejects.toThrow('podman build exited with code 1')
  })

  it('refuses an upstream mirror built for another architecture', async () => {
    // A digest pinned to one platform's manifest would crashloop on other
    // hosts with `exec format error`. The arch check fails at mirror time.
    const realArch = process.arch
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    try {
      mockExecFile.mockImplementation((_file: string, args: string[]) =>
        Promise.resolve({
          stdout: args.includes('inspect') && args.some((a) => a.includes('Architecture'))
            ? 'arm64'
            : '',
          stderr: '',
        }))
      await expect(buildBuiltinImages({ log: vi.fn() }))
        .rejects.toThrow(/is a arm64 image but this host is amd64/)
    } finally {
      Object.defineProperty(process, 'arch', { value: realArch, configurable: true })
    }
  })

  it('sweeps the host store, and finishes even when the sweep fails', async () => {
    mockRegistryHasTag.mockResolvedValue(true)
    // A failing image GC must not fail an otherwise complete install.
    mockExecFile.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === 'image' && args[1] === 'ls'
        ? Promise.reject(new Error('cannot connect to podman'))
        : Promise.resolve({ stdout: '', stderr: '' }))
    const log = vi.fn()

    await expect(buildBuiltinImages({ log })).resolves.toBeUndefined()

    expect(log.mock.calls.map((c) => String(c[0])).join('\n'))
      .toMatch(/could not sweep the host image store/)
  })
})
