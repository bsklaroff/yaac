import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

vi.mock('#lib/k8s/exec', async (importOriginal) => {
  const actual = await importOriginal<typeof execModule>()
  return { ...actual, containerExec: vi.fn() }
})

import { containerExec } from '#lib/k8s/exec'
import type * as execModule from '#lib/k8s/exec'
import {
  PROMOTER_SCRIPT,
  buildPromoterShellCommand,
  promoteSessionImages,
  promoterExecCommand,
  sharedImageStoreHostPath,
} from '#lib/container/image-promoter'
import {
  NESTED_GRAPHROOT_PATH,
  SHARED_IMAGE_STORE_DST_PATH,
  SHARED_IMAGE_STORE_PATH,
} from '#lib/k8s/pod-spec'
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

  it('serializes cross-pod via a host-side mkdir lock (flock is sentry-local under gVisor)', () => {
    expect(PROMOTER_SCRIPT).toContain(`lockdir=${SHARED_IMAGE_STORE_DST_PATH}/.yaac-promoter.lockdir`)
    expect(PROMOTER_SCRIPT).toContain('while ! mkdir "$lockdir" 2>/dev/null; do')
    // Stale-holder steal (a died promoter can never rmdir its own lock).
    expect(PROMOTER_SCRIPT).toContain('-mmin +20')
    // Release on every shell exit.
    expect(PROMOTER_SCRIPT).toContain(`trap 'rmdir "$lockdir" 2>/dev/null' EXIT`)
    // No flock anywhere: under gVisor it never reaches the host kernel.
    expect(PROMOTER_SCRIPT).not.toContain('flock')
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

  it('is valid POSIX shell, as is the exec command wrapping it', async () => {
    // sh -n parses without executing — catches quoting/structure breakage
    // in the generated script and in the sudo-gate wrapper around it.
    await expect(execFileAsync('sh', ['-n', '-c', PROMOTER_SCRIPT])).resolves.toBeTruthy()
    await expect(execFileAsync('sh', ['-n', '-c', promoterExecCommand()])).resolves.toBeTruthy()
  })
})

describe('promoterExecCommand', () => {
  it('gates on usable passwordless sudo before the sudo-run script', () => {
    const cmd = promoterExecCommand()
    // Images without passwordless sudo (custom Dockerfile.yaac) must
    // no-op quietly — the script's own store self-gate needs sudo to run.
    expect(cmd.startsWith("sh -c '")).toBe(true)
    expect(cmd).toContain('command -v sudo >/dev/null 2>&1 || exit 0')
    expect(cmd).toContain('sudo -n true 2>/dev/null || exit 0')
    // Rootful engine → the promoter itself runs under sudo (-n: no
    // password prompt; -H sets $HOME for the script's `set -u`).
    expect(cmd).toContain('exec sudo -n -H sh -c ')
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
