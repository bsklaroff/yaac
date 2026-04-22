import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/container/runtime', () => ({
  podman: {
    getVolume: vi.fn(),
    createVolume: vi.fn(),
    listVolumes: vi.fn(),
    listContainers: vi.fn(),
    createContainer: vi.fn(),
  },
  shellPodmanWithRetry: vi.fn(),
}))

vi.mock('@/lib/project/paths', () => ({
  getDataDir: () => '/tmp/yaac-data',
}))

import { podman, shellPodmanWithRetry } from '@/lib/container/runtime'
import {
  sessionGraphrootVolumeName,
  projectImageCacheVolumeName,
  ensureNestedStorageVolumes,
  removeSessionGraphrootVolume,
  removeProjectImageCacheVolume,
  gcOrphanSessionVolumes,
  buildPromoterShellCommand,
  promoteSessionImages,
  PROMOTER_SCRIPT,
  SHARED_IMAGE_STORE_PATH,
  GRAPHROOT_LABEL,
  IMAGECACHE_LABEL,
} from '@/lib/container/image-promoter'

/* eslint-disable @typescript-eslint/unbound-method */
const mockGetVolume = vi.mocked(podman.getVolume)
const mockCreateVolume = vi.mocked(podman.createVolume)
const mockListVolumes = vi.mocked(podman.listVolumes)
const mockListContainers = vi.mocked(podman.listContainers)
const mockCreateContainer = vi.mocked(podman.createContainer)
/* eslint-enable @typescript-eslint/unbound-method */
const mockShellPodman = vi.mocked(shellPodmanWithRetry)

beforeEach(() => {
  mockGetVolume.mockReset()
  mockCreateVolume.mockReset()
  mockListVolumes.mockReset()
  mockListContainers.mockReset()
  mockCreateContainer.mockReset()
  mockShellPodman.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sessionGraphrootVolumeName / projectImageCacheVolumeName', () => {
  it('derives a per-session graphroot volume name', () => {
    expect(sessionGraphrootVolumeName('abc-123')).toBe('yaac-podmanstorage-abc-123')
  })

  it('derives a project image-cache volume name', () => {
    expect(projectImageCacheVolumeName('my-proj')).toBe('yaac-imagecache-my-proj')
  })
})

describe('ensureNestedStorageVolumes', () => {
  it('creates both volumes with labels when neither exists', async () => {
    mockGetVolume.mockImplementation(() => ({
      inspect: vi.fn().mockRejectedValue(new Error('no such volume')),
    }) as never)
    mockCreateVolume.mockResolvedValue({} as never)

    const result = await ensureNestedStorageVolumes('slug-x', 'sess-y')

    expect(result).toEqual({
      graphroot: 'yaac-podmanstorage-sess-y',
      imageCache: 'yaac-imagecache-slug-x',
    })
    expect(mockCreateVolume).toHaveBeenCalledTimes(2)
    const graphrootCall = mockCreateVolume.mock.calls.find(
      ([arg]) => (arg as { Name: string }).Name === 'yaac-podmanstorage-sess-y',
    )
    const imageCacheCall = mockCreateVolume.mock.calls.find(
      ([arg]) => (arg as { Name: string }).Name === 'yaac-imagecache-slug-x',
    )
    expect(graphrootCall).toBeDefined()
    expect(imageCacheCall).toBeDefined()
    const graphrootLabels = (graphrootCall![0] as { Labels: Record<string, string> }).Labels
    expect(graphrootLabels[GRAPHROOT_LABEL]).toBe('true')
    expect(graphrootLabels['yaac.project']).toBe('slug-x')
    expect(graphrootLabels['yaac.session-id']).toBe('sess-y')
    expect(graphrootLabels['yaac.data-dir']).toBe('/tmp/yaac-data')
    const imageCacheLabels = (imageCacheCall![0] as { Labels: Record<string, string> }).Labels
    expect(imageCacheLabels[IMAGECACHE_LABEL]).toBe('true')
    expect(imageCacheLabels['yaac.project']).toBe('slug-x')
    expect(imageCacheLabels['yaac.data-dir']).toBe('/tmp/yaac-data')
  })

  it('skips creation when volumes already exist', async () => {
    mockGetVolume.mockImplementation(() => ({
      inspect: vi.fn().mockResolvedValue({}),
    }) as never)

    await ensureNestedStorageVolumes('slug-x', 'sess-y')

    expect(mockCreateVolume).not.toHaveBeenCalled()
  })

  it('swallows "already exists" races on createVolume', async () => {
    mockGetVolume.mockImplementation(() => ({
      inspect: vi.fn().mockRejectedValue(new Error('no such volume')),
    }) as never)
    mockCreateVolume.mockRejectedValue(new Error('volume already exists'))

    await expect(
      ensureNestedStorageVolumes('slug-x', 'sess-y'),
    ).resolves.toBeDefined()
  })
})

describe('removeSessionGraphrootVolume / removeProjectImageCacheVolume', () => {
  it('shells out to podman volume rm -f for the per-session graphroot', async () => {
    mockShellPodman.mockResolvedValue({ stdout: '', stderr: '' })

    await removeSessionGraphrootVolume('sess-y')

    expect(mockShellPodman).toHaveBeenCalledWith(
      'podman volume rm -f yaac-podmanstorage-sess-y',
    )
  })

  it('shells out to podman volume rm -f for the shared image cache', async () => {
    mockShellPodman.mockResolvedValue({ stdout: '', stderr: '' })

    await removeProjectImageCacheVolume('slug-x')

    expect(mockShellPodman).toHaveBeenCalledWith(
      'podman volume rm -f yaac-imagecache-slug-x',
    )
  })

  it('swallows errors (volume already gone)', async () => {
    mockShellPodman.mockRejectedValue(new Error('no such volume'))

    await expect(removeSessionGraphrootVolume('sess-y')).resolves.toBeUndefined()
    await expect(removeProjectImageCacheVolume('slug-x')).resolves.toBeUndefined()
  })
})

describe('gcOrphanSessionVolumes', () => {
  it('removes volumes whose session container is gone', async () => {
    mockListContainers.mockResolvedValue([
      { Labels: { 'yaac.session-id': 'live-1' } },
    ] as never)
    mockListVolumes.mockResolvedValue({
      Volumes: [
        { Name: 'yaac-podmanstorage-live-1', Labels: { 'yaac.session-id': 'live-1' } },
        { Name: 'yaac-podmanstorage-dead-1', Labels: { 'yaac.session-id': 'dead-1' } },
        { Name: 'yaac-podmanstorage-dead-2', Labels: { 'yaac.session-id': 'dead-2' } },
      ],
    } as never)
    mockShellPodman.mockResolvedValue({ stdout: '', stderr: '' })

    await gcOrphanSessionVolumes()

    expect(mockShellPodman).toHaveBeenCalledWith(
      'podman volume rm -f yaac-podmanstorage-dead-1',
    )
    expect(mockShellPodman).toHaveBeenCalledWith(
      'podman volume rm -f yaac-podmanstorage-dead-2',
    )
    expect(mockShellPodman).not.toHaveBeenCalledWith(
      'podman volume rm -f yaac-podmanstorage-live-1',
    )
    expect(mockShellPodman).toHaveBeenCalledTimes(2)
  })

  it('returns quietly if container listing fails', async () => {
    mockListContainers.mockRejectedValue(new Error('podman offline'))

    await expect(gcOrphanSessionVolumes()).resolves.toBeUndefined()
    expect(mockListVolumes).not.toHaveBeenCalled()
  })

  it('returns quietly if volume listing fails', async () => {
    mockListContainers.mockResolvedValue([] as never)
    mockListVolumes.mockRejectedValue(new Error('podman volume endpoint broken'))

    await expect(gcOrphanSessionVolumes()).resolves.toBeUndefined()
    expect(mockShellPodman).not.toHaveBeenCalled()
  })

  it('filters by data-dir and graphroot label so other yaac installs are not touched', async () => {
    mockListContainers.mockResolvedValue([] as never)
    mockListVolumes.mockResolvedValue({ Volumes: [] } as never)

    await gcOrphanSessionVolumes()

    const containerFilters = mockListContainers.mock.calls[0]?.[0] as
      | { filters?: { label?: string[] } } | undefined
    expect(containerFilters?.filters?.label).toContain('yaac.data-dir=/tmp/yaac-data')

    const volumeFilters = mockListVolumes.mock.calls[0]?.[0] as
      | { filters?: { label?: string[] } } | undefined
    expect(volumeFilters?.filters?.label).toContain(`${GRAPHROOT_LABEL}=true`)
    expect(volumeFilters?.filters?.label).toContain('yaac.data-dir=/tmp/yaac-data')
  })
})

describe('buildPromoterShellCommand', () => {
  it('includes volume binds, label=disable, and the inline script', () => {
    const cmd = buildPromoterShellCommand('slug-x', 'sess-y', 'yaac-base-nestable:abcdef')
    // Source graphroot mounts at the session's original path so podman's
    // sqlite db's recorded static dir matches — remounting at /src causes
    // "database configuration mismatch".
    expect(cmd).toContain('-v yaac-podmanstorage-sess-y:/home/yaac/.local/share/containers:rw')
    expect(cmd).toContain('-v yaac-imagecache-slug-x:/dst:rw')
    expect(cmd).toContain('--security-opt label=disable')
    expect(cmd).toContain('--user yaac')
    // The base image's ENTRYPOINT is `catatonit -- sleep infinity`; the
    // promoter overrides it so `-c '<script>'` reaches sh, not sleep.
    expect(cmd).toContain('--entrypoint /bin/sh')
    expect(cmd).toContain('yaac-base-nestable:abcdef')
    expect(cmd).toContain('skopeo copy')
    expect(cmd).toContain('flock -x 9')
  })
})

describe('promoteSessionImages', () => {
  it('runs a one-shot promoter container mounting both volumes', async () => {
    const start = vi.fn().mockResolvedValue(undefined)
    const waitCall = vi.fn().mockResolvedValue({ StatusCode: 0 })
    const remove = vi.fn().mockResolvedValue(undefined)
    mockCreateContainer.mockResolvedValue(
      { start, wait: waitCall, remove } as never,
    )

    await promoteSessionImages('slug-x', 'sess-y', 'yaac-base-nestable:abc')

    const call = mockCreateContainer.mock.calls[0]?.[0] as {
      Image: string
      User: string
      Entrypoint: string[]
      Cmd: string[]
      HostConfig: {
        AutoRemove?: boolean
        SecurityOpt: string[]
        Binds: string[]
      }
    }
    expect(call.Image).toBe('yaac-base-nestable:abc')
    // Run as `yaac` (the session's user) so ownership and podman's baked-in
    // paths match the source graphroot.
    expect(call.User).toBe('yaac')
    // The base image's ENTRYPOINT is `catatonit -- sleep infinity`; override
    // it so Cmd's `-c '<script>'` reaches sh instead of being appended after
    // `sleep infinity`.
    expect(call.Entrypoint).toEqual(['/bin/sh'])
    expect(call.Cmd[0]).toBe('-c')
    // AutoRemove must NOT be set — we explicitly remove after wait() so the
    // shared cache volume is free for removal in the same teardown flow.
    expect(call.HostConfig.AutoRemove).toBeUndefined()
    expect(call.HostConfig.SecurityOpt).toContain('label=disable')
    // Source graphroot mounts at its session-original path (the podman
    // sqlite db rejects `--root` overrides with a config mismatch).
    expect(call.HostConfig.Binds).toContain('yaac-podmanstorage-sess-y:/home/yaac/.local/share/containers:rw')
    expect(call.HostConfig.Binds).toContain('yaac-imagecache-slug-x:/dst:rw')
    expect(start).toHaveBeenCalled()
    expect(waitCall).toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith({ force: true })
  })

  it('swallows container-create failures', async () => {
    mockCreateContainer.mockRejectedValue(new Error('oci boom'))
    await expect(
      promoteSessionImages('slug-x', 'sess-y', 'img:tag'),
    ).resolves.toBeUndefined()
  })
})

describe('PROMOTER_SCRIPT and SHARED_IMAGE_STORE_PATH constants', () => {
  it('exposes a shared image store path used by session binds', () => {
    expect(SHARED_IMAGE_STORE_PATH).toBe('/var/lib/shared-images')
  })

  it('flocks the shared store and walks source images', () => {
    expect(PROMOTER_SCRIPT).toContain('flock -x 9')
    // The source side uses podman's default storage (the mount lands at
    // /home/yaac/.local/share/containers); only the destination passes
    // --root so the fresh /dst store is isolated from the source db.
    expect(PROMOTER_SCRIPT).toContain('podman image ls -a -q --no-trunc')
    expect(PROMOTER_SCRIPT).toContain('podman --root /dst --runroot /tmp/dst-run')
    expect(PROMOTER_SCRIPT).toContain('containers-storage:[overlay@/dst+/tmp/dst-run]')
  })

  it('restores tags on the destination store so FROM refs resolve by name', () => {
    // Pass 2 walks `id|repo:tag` rows, drops dangling (`<none>:<none>`),
    // and re-tags by id on /dst. Without this, skopeo's `@<id>` copy in
    // pass 1 leaves every promoted image untagged and a `FROM foo:bar`
    // in a later session falls back to a registry manifest fetch.
    expect(PROMOTER_SCRIPT).toContain(
      "podman image ls --no-trunc --format '{{.ID}}|{{.Repository}}:{{.Tag}}'",
    )
    expect(PROMOTER_SCRIPT).toContain("grep -v '|<none>:<none>$'")
    expect(PROMOTER_SCRIPT).toContain(
      'podman --root /dst --runroot /tmp/dst-run tag',
    )
  })

  it('prunes dangling images on /dst older than 7d', () => {
    // Tag re-points (rebuild `foo:bar` to a new id) orphan the old id as
    // dangling; without a sweep the shared cache grows unbounded. 168h
    // keeps recent build intermediates alive for cross-session layer reuse.
    expect(PROMOTER_SCRIPT).toContain(
      "podman --root /dst --runroot /tmp/dst-run image prune --filter 'dangling=true' --filter 'until=168h' -f",
    )
  })
})
