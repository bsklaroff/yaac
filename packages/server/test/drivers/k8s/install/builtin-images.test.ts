/**
 * The image half of `yaac cluster install`: what it builds, what it
 * mirrors, and what it skips.
 *
 * Mocked at the process boundary only — podman (through the container
 * folder's exec + image-store helpers) and the registry client — so the
 * real tag resolution runs and the assertions land on the tags a worktree
 * create will look up.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as registryModule from '#drivers/k8s/container/registry'
import type * as runtimeModule from '#drivers/k8s/container/runtime'
import type * as hostProcsModule from '#drivers/k8s/container/host-procs'
import type * as childProcessModule from 'node:child_process'

vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))

// The real process boundary: every mirror shells out to podman through a
// promisified execFile of its own, so mocking node:child_process is what
// covers all of them at once (mocking one module's re-export would not).
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
import { listImageBuilds, resolveTrustedLayers } from '#drivers/k8s/image-engine'
// State-reset hook, not a unit under test: the build registry is module
// state, and these cases assert what one run put in it.
import { clearAllImageBuildsForTests } from '#drivers/k8s/image-engine/image-builds'
// Setup values: the compression the trusted pushes must carry and the tag
// the builder mirror lands under.
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
  clearAllImageBuildsForTests()
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

    const { base, tools, nestable } = await resolveTrustedLayers('yaac')
    // In dependency order: each layer is the next one's FROM, so the tags
    // are only derivable — and only buildable — in this sequence.
    expect(built().slice(0, 3)).toEqual([base.tag, tools.tag, nestable.tag])
    // Pushed with zstd: these are the blobs a sandboxed builder pod pulls
    // as its parent.
    for (const layer of [base, tools, nestable]) {
      expect(mockPush).toHaveBeenCalledWith(
        layer.tag, { compressionFormat: TRUSTED_PARENT_COMPRESSION },
      )
    }
  })

  it('builds the proxy and netd images, and mirrors every pinned upstream', async () => {
    await buildBuiltinImages({ log: vi.fn() })

    // The two other yaac-built contexts, content-hash tagged like the chain.
    expect(built().some((t) => t.startsWith('yaac-proxy:'))).toBe(true)
    expect(built().some((t) => t.startsWith('yaac-netd:'))).toBe(true)
    // The digest-pinned upstreams: pulled and retagged with podman, then
    // pushed, so a node never reaches upstream at pod-create time.
    const pulls = mockExecFile.mock.calls
      .filter(([, a]) => a[0] === 'pull').map(([, a]) => a[1])
    expect(pulls.some((r) => r.includes('library/registry@sha256:'))).toBe(true)
    expect(pulls.some((r) => r.includes('envoyproxy/envoy@sha256:'))).toBe(true)
    expect(pulls.some((r) => r.includes('podman/stable@sha256:'))).toBe(true)
    expect(pulls.some((r) => r.includes('curlimages/curl@sha256:'))).toBe(true)
    // Retagged locally before the push, so the node pulls the mirror name.
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
    // The whole point of content-hash tags: re-running install after an
    // upgrade that changed nothing costs a handful of registry HEADs.
    mockRegistryHasTag.mockResolvedValue(true)

    await buildBuiltinImages({ log: vi.fn() })

    expect(built()).toEqual([])
    expect(mockPush).not.toHaveBeenCalled()
    // Nothing pulled either — the mirrors short-circuit on the same check.
    expect(mockExecFile.mock.calls.some(([, a]) => a[0] === 'pull')).toBe(false)
  })

  it('marks a failed image build failed in the registry, and rethrows', async () => {
    // The proxy and netd builds register a row so the webapp's build list
    // shows them; a build that dies has to leave that row FAILED rather
    // than running forever, and must not be swallowed — install's whole
    // job is to end red when an image did not get made.
    mockRegistryHasTag.mockResolvedValue(false)
    // Only the proxy's build dies, so the run reaches it with the trusted
    // chain already behind it — the chain itself keeps no registry row.
    mockRunTrackedPodman.mockImplementation((_args: string[], opts: { tag: string }) =>
      opts.tag.startsWith('yaac-proxy:')
        ? Promise.reject(new Error('podman build exited with code 1'))
        : Promise.resolve(undefined))

    await expect(buildBuiltinImages({ log: vi.fn() }))
      .rejects.toThrow('podman build exited with code 1')

    const failed = listImageBuilds().filter((e) => e.status === 'failed')
    expect(failed).not.toHaveLength(0)
    expect(failed[0].error).toContain('exited with code 1')
  })

  it('refuses an upstream mirror built for another architecture', async () => {
    // A pin that names one platform's CHILD manifest mirrors those bytes
    // onto every host, and the node then crashloops the sidecar on `exec
    // format error` — which surfaces only as netd never going ready. The
    // re-check makes a bad re-pin fail at mirror time instead.
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
    // `image ls` is the sweep's first call; a broken engine there must not
    // undo an otherwise complete install.
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
