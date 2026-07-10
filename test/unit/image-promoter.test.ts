import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

vi.mock('@yaac/server/lib/k8s/exec', async (importOriginal) => {
  const actual = await importOriginal<typeof execModule>()
  return { ...actual, containerExec: vi.fn() }
})

import { containerExec } from '@yaac/server/lib/k8s/exec'
import type * as execModule from '@yaac/server/lib/k8s/exec'
import {
  PROMOTER_SCRIPT,
  buildPromoterShellCommand,
  promoteSessionImages,
  promoterExecCommand,
  sharedImageStoreHostPath,
} from '@yaac/server/lib/container/image-promoter'
import {
  NESTED_GRAPHROOT_PATH,
  SHARED_IMAGE_STORE_DST_PATH,
  SHARED_IMAGE_STORE_PATH,
} from '@yaac/server/lib/k8s/pod-spec'
import { setDataDir } from '@yaac/shared/project-paths'

const mockContainerExec = vi.mocked(containerExec)

describe('sharedImageStoreHostPath', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-promoter-'))
    setDataDir(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('keys the node-local store by data-dir hash and project slug', () => {
    const ddh = crypto.createHash('sha256').update(dataDir).digest('hex').slice(0, 16)
    expect(sharedImageStoreHostPath('my-proj')).toBe(
      `/var/lib/yaac/imagecache/${ddh}/my-proj`,
    )
  })

  it('separates projects and installs', () => {
    const a = sharedImageStoreHostPath('proj-a')
    const b = sharedImageStoreHostPath('proj-b')
    expect(a).not.toBe(b)
  })
})

describe('PROMOTER_SCRIPT', () => {
  it('self-gates so non-nested pods (no store mount, no podman) exit 0 immediately', () => {
    const lines = PROMOTER_SCRIPT.split('\n')
    expect(lines[1]).toBe(`[ -d ${SHARED_IMAGE_STORE_DST_PATH} ] || exit 0`)
    expect(lines[2]).toBe('command -v podman >/dev/null 2>&1 || exit 0')
  })

  it('serializes on an exclusive flock inside the shared store', () => {
    expect(PROMOTER_SCRIPT).toContain(`exec 9>${SHARED_IMAGE_STORE_DST_PATH}/.yaac-promoter.lock`)
    expect(PROMOTER_SCRIPT).toContain('flock -x 9')
  })

  it('writes through the dst path to dodge the read-only additional-store lock', () => {
    // Pass 1: unambiguous image-id refs (strip the sha256: prefix, @<hex>).
    expect(PROMOTER_SCRIPT).toContain('sed -e "s/^sha256://"')
    // The destination is the second mount, never SHARED_IMAGE_STORE_PATH
    // (which the session opens read-only as its additional store).
    expect(PROMOTER_SCRIPT).toContain(
      `skopeo copy "containers-storage:@$id" "containers-storage:[overlay@${SHARED_IMAGE_STORE_DST_PATH}+/tmp/dst-run]@$id"`,
    )
    expect(PROMOTER_SCRIPT).not.toContain(`[overlay@${SHARED_IMAGE_STORE_PATH}+`)
    // Pass 2: tag restore on the destination store.
    expect(PROMOTER_SCRIPT).toContain(
      `podman --root ${SHARED_IMAGE_STORE_DST_PATH} --runroot /tmp/dst-run tag "$tid" "$tref"`,
    )
    // Pass 3: the GC story for the store.
    expect(PROMOTER_SCRIPT).toContain("--filter 'dangling=true' --filter 'until=168h' -f")
  })

  it('reads the source from the graphroot path the sqlite db was created under', () => {
    expect(PROMOTER_SCRIPT).toContain(`${NESTED_GRAPHROOT_PATH}/storage/overlay-images`)
  })
})

describe('promoterExecCommand', () => {
  it('single-quotes the script for the in-pod sh -c, escaping embedded quotes', () => {
    const cmd = promoterExecCommand()
    expect(cmd.startsWith("sh -c '")).toBe(true)
    expect(cmd.endsWith("'")).toBe(true)
    // Embedded single quotes survive via the '\'' dance.
    expect(cmd).toContain("'\\''")
  })
})

describe('promoteSessionImages', () => {
  beforeEach(() => {
    mockContainerExec.mockReset()
  })

  it('runs the promoter script in the session pod and reports success', async () => {
    mockContainerExec.mockResolvedValue({ stdout: '', stderr: '' })
    await expect(promoteSessionImages('yaac-demo-abc')).resolves.toBe(true)
    expect(mockContainerExec).toHaveBeenCalledWith(
      'yaac-demo-abc',
      promoterExecCommand(),
      { timeout: 300_000, maxAttempts: 1 },
    )
  })

  it('swallows failures (teardown is never blocked on cache salvage)', async () => {
    mockContainerExec.mockRejectedValue(new Error('pod is gone'))
    await expect(promoteSessionImages('yaac-demo-abc')).resolves.toBe(false)
  })
})

describe('buildPromoterShellCommand', () => {
  it('builds a kubectl exec one-liner that never fails the detached script', () => {
    const cmd = buildPromoterShellCommand('yaac-demo-abc')
    expect(cmd.startsWith('kubectl exec -n yaac job/yaac-demo-abc -- sh -c ')).toBe(true)
    expect(cmd.endsWith('|| true')).toBe(true)
    // Same in-pod command as the in-process path.
    expect(cmd).toContain(promoterExecCommand())
  })
})
