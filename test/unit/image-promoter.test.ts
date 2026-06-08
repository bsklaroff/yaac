import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/container/runtime', () => ({
  podman: {
    getVolume: vi.fn(),
    createVolume: vi.fn(),
    listVolumes: vi.fn(),
    listContainers: vi.fn(),
  },
  shellPodmanWithRetry: vi.fn(),
  keepIdEnabled: vi.fn().mockReturnValue(true),
}))

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

vi.mock('@/lib/project/paths', () => ({
  getDataDir: () => '/tmp/yaac-data',
}))

import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { podman, shellPodmanWithRetry } from '@/lib/container/runtime'
import {
  sessionGraphrootVolumeName,
  projectImageCacheVolumeName,
  ensureNestedStorageVolumes,
  removeSessionGraphrootVolume,
  removeProjectImageCacheVolume,
  gcOrphanSessionVolumes,
  buildPromoterRunArgs,
  buildPromoterShellCommand,
  promoteSessionImages,
  resolvePromotableSession,
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
/* eslint-enable @typescript-eslint/unbound-method */
const mockShellPodman = vi.mocked(shellPodmanWithRetry)
const mockSpawn = vi.mocked(spawn)

/**
 * Minimal stand-in for a ChildProcess: an EventEmitter with `stdout`/`stderr`
 * sub-emitters, so a test can drive `data`/`close`/`error` events.
 */
interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
}
function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

beforeEach(() => {
  mockGetVolume.mockReset()
  mockCreateVolume.mockReset()
  mockListVolumes.mockReset()
  mockListContainers.mockReset()
  mockShellPodman.mockReset()
  mockSpawn.mockReset()
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

describe('buildPromoterRunArgs', () => {
  it('builds a self-removing `podman run` argv with binds, labels, and the script', () => {
    const args = buildPromoterRunArgs({
      projectSlug: 'slug-x', sessionId: 'sess-y', imageRef: 'img:tag', keepId: true,
    })
    expect(args.slice(0, 2)).toEqual(['run', '--rm'])
    // keep-id maps the promoter's yaac user to the host daemon UID.
    expect(args).toContain('--userns')
    expect(args).toContain('keep-id')
    // Source graphroot mounts at its session-original path (the podman sqlite
    // db rejects `--root` overrides with a config mismatch).
    expect(args).toContain('yaac-podmanstorage-sess-y:/home/yaac/.local/share/containers:rw')
    expect(args).toContain('yaac-imagecache-slug-x:/dst:rw')
    // The cache is also mounted at the additionalimagestores path so the source
    // store can resolve layers of images built FROM a cached base.
    expect(args).toContain('yaac-imagecache-slug-x:/var/lib/shared-images:rw')
    // Labels mirror the old dockerode path for orphan GC.
    expect(args).toContain('yaac.promoter=true')
    expect(args).toContain('yaac.project=slug-x')
    expect(args).toContain('yaac.session-id=sess-y')
    expect(args).toContain('yaac.data-dir=/tmp/yaac-data')
    expect(args).toContain('img:tag')
    // The inline script is carried as the final `-c <script>` argument.
    expect(args[args.length - 2]).toBe('-c')
    expect(args[args.length - 1]).toBe(PROMOTER_SCRIPT)
  })

  it('omits the keep-id userns flag when keepId is false', () => {
    const args = buildPromoterRunArgs({
      projectSlug: 's', sessionId: 'x', imageRef: 'i:t', keepId: false,
    })
    expect(args).not.toContain('--userns')
    expect(args).not.toContain('keep-id')
  })
})

describe('buildPromoterShellCommand', () => {
  it('shell-quotes the same argv as the spawned promoter', () => {
    const cmd = buildPromoterShellCommand('slug-x', 'sess-y', 'yaac-base-nestable:abcdef')
    expect(cmd.startsWith('podman ')).toBe(true)
    // Each argv token is single-quoted; the binds, security flag, entrypoint
    // override, and image all appear as quoted tokens.
    expect(cmd).toContain("'yaac-podmanstorage-sess-y:/home/yaac/.local/share/containers:rw'")
    expect(cmd).toContain("'yaac-imagecache-slug-x:/dst:rw'")
    expect(cmd).toContain("'yaac-imagecache-slug-x:/var/lib/shared-images:rw'")
    expect(cmd).toContain("'label=disable'")
    expect(cmd).toContain("'/bin/sh'")
    expect(cmd).toContain("'yaac-base-nestable:abcdef'")
    // keepIdEnabled() is mocked true → the userns flag is present.
    expect(cmd).toContain("'--userns' 'keep-id'")
    // The inline script is carried as the final quoted -c argument.
    expect(cmd).toContain('skopeo copy')
    expect(cmd).toContain('flock -x 9')
  })
})

describe('promoteSessionImages', () => {
  it('spawns `podman run` with both volume binds and resolves the exit code', async () => {
    mockSpawn.mockImplementation(((_cmd: string, _args: string[]) => {
      const child = makeFakeChild()
      queueMicrotask(() => child.emit('close', 0))
      return child
    }) as never)

    const code = await promoteSessionImages('slug-x', 'sess-y', 'yaac-base-nestable:abc')
    expect(code).toBe(0)

    const [cmd, args, opts] = mockSpawn.mock.calls[0] as [string, string[], { stdio: unknown[] }]
    expect(cmd).toBe('podman')
    expect(args.slice(0, 2)).toEqual(['run', '--rm'])
    expect(args).toContain('yaac-base-nestable:abc')
    expect(args).toContain('yaac-podmanstorage-sess-y:/home/yaac/.local/share/containers:rw')
    expect(args).toContain('yaac-imagecache-slug-x:/dst:rw')
    expect(args).toContain('yaac-imagecache-slug-x:/var/lib/shared-images:rw')
    expect(args).toContain('label=disable')
    expect(args).toContain('/bin/sh')
    // No onLog → stdout/stderr are ignored (not piped).
    expect(opts.stdio).toEqual(['ignore', 'ignore', 'ignore'])
  })

  it('streams promoter log lines to onLog and returns a non-zero exit code', async () => {
    mockSpawn.mockImplementation((() => {
      const child = makeFakeChild()
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('[promoter] start\n[promoter] COPY abc OK\n'))
        child.stderr.emit('data', Buffer.from('skopeo: boom\n'))
        child.emit('close', 7)
      })
      return child
    }) as never)

    const lines: string[] = []
    const code = await promoteSessionImages('slug-x', 'sess-y', 'img:tag', {
      onLog: (l) => lines.push(l),
    })
    expect(code).toBe(7)
    expect(lines).toContain('[promoter] start')
    expect(lines).toContain('[promoter] COPY abc OK')
    expect(lines).toContain('skopeo: boom')
    // onLog → stdout/stderr piped so the lines can be captured.
    const opts = mockSpawn.mock.calls[0][2]
    expect(opts?.stdio).toEqual(['ignore', 'pipe', 'pipe'])
  })

  it('swallows spawn failures and returns -1', async () => {
    mockSpawn.mockImplementation((() => {
      const child = makeFakeChild()
      queueMicrotask(() => child.emit('error', new Error('podman not found')))
      return child
    }) as never)
    await expect(promoteSessionImages('slug-x', 'sess-y', 'img:tag')).resolves.toBe(-1)
  })
})

describe('resolvePromotableSession', () => {
  it('resolves project + session id from the graphroot volume labels', async () => {
    mockListVolumes.mockResolvedValue({
      Volumes: [
        { Name: 'yaac-podmanstorage-sess-1', Labels: { 'yaac.session-id': 'sess-1', 'yaac.project': 'proj-a' } },
        { Name: 'yaac-podmanstorage-sess-2', Labels: { 'yaac.session-id': 'sess-2', 'yaac.project': 'proj-b' } },
      ],
    } as never)
    await expect(resolvePromotableSession('sess-2')).resolves.toEqual({
      sessionId: 'sess-2', projectSlug: 'proj-b',
    })
  })

  it('accepts a unique prefix', async () => {
    mockListVolumes.mockResolvedValue({
      Volumes: [
        { Name: 'yaac-podmanstorage-abc123', Labels: { 'yaac.session-id': 'abc123', 'yaac.project': 'proj-a' } },
      ],
    } as never)
    await expect(resolvePromotableSession('abc')).resolves.toEqual({
      sessionId: 'abc123', projectSlug: 'proj-a',
    })
  })

  it('prefers an exact id match over longer prefix matches', async () => {
    mockListVolumes.mockResolvedValue({
      Volumes: [
        { Name: 'yaac-podmanstorage-abc', Labels: { 'yaac.session-id': 'abc', 'yaac.project': 'exact' } },
        { Name: 'yaac-podmanstorage-abc1', Labels: { 'yaac.session-id': 'abc1', 'yaac.project': 'longer' } },
      ],
    } as never)
    await expect(resolvePromotableSession('abc')).resolves.toEqual({
      sessionId: 'abc', projectSlug: 'exact',
    })
  })

  it('throws when no graphroot volume matches', async () => {
    mockListVolumes.mockResolvedValue({ Volumes: [] } as never)
    await expect(resolvePromotableSession('nope')).rejects.toThrow(/No per-session graphroot/)
  })

  it('throws on an ambiguous prefix', async () => {
    mockListVolumes.mockResolvedValue({
      Volumes: [
        { Name: 'yaac-podmanstorage-abc1', Labels: { 'yaac.session-id': 'abc1', 'yaac.project': 'p' } },
        { Name: 'yaac-podmanstorage-abc2', Labels: { 'yaac.session-id': 'abc2', 'yaac.project': 'p' } },
      ],
    } as never)
    await expect(resolvePromotableSession('abc')).rejects.toThrow(/Ambiguous/)
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

  it('logs per-image copy outcomes instead of silently swallowing failures', () => {
    // log() fans out to stdout (streamed by `yaac session promote`) and a
    // persistent audit log in the shared cache volume.
    expect(PROMOTER_SCRIPT).toContain('log() {')
    expect(PROMOTER_SCRIPT).toContain('>> /dst/.yaac-promoter.log')
    // A failed copy is reported with skopeo's captured stderr, not dropped.
    expect(PROMOTER_SCRIPT).toContain('log "COPY  $id FAILED: $err"')
  })
})
