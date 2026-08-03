/**
 * Image salvage, exercised through `salvageSessionImages`.
 *
 * The survey script, its sudo wrapper, the report parser, the writer pod
 * manifest and the writer script are all things salvage hands to the
 * cluster on the way through one teardown. Driving the barrel entry rather
 * than each generator means the pieces are checked as they are actually
 * wired — a parser that silently stops feeding the writer's argv, or a
 * script that stops being reachable, fails here instead of staying green in
 * isolation.
 *
 * `ensureSalvageWriterImage` and `sharedImageStoreHostPath` are themselves
 * barrel entries, so they keep direct tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type * as execModule from '#platform/k8s/exec'
import type * as kubectlModule from '#platform/k8s/kubectl'
import type * as registryModule from '#platform/container/registry'

const mockContainerExec = vi.hoisted(() => vi.fn())
vi.mock('#platform/k8s/exec', async (importOriginal) => ({
  ...(await importOriginal<typeof execModule>()),
  containerExec: mockContainerExec,
}))

const mockKubectlWithRetry = vi.hoisted(() => vi.fn())
const mockKubectlApply = vi.hoisted(() => vi.fn())
vi.mock('#platform/k8s/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'test-ns',
  dataDirHash: () => 'ddh16chars000000',
  kubectlWithRetry: mockKubectlWithRetry,
  kubectlApply: mockKubectlApply,
}))

const mockRegistryHasTag = vi.hoisted(() => vi.fn())
vi.mock('#platform/container/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof registryModule>()),
  registryHasTag: mockRegistryHasTag,
  registryRef: (tag: string) => `localhost:5001/${tag}`,
  pushImageToRegistry: vi.fn(),
}))

vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))

import { salvageSessionImages, ensureSalvageWriterImage, sharedImageStoreHostPath } from '#features/images'
// Policy constants and the upstream pin: expected values for the
// assertions below, not units under test.
import {
  ROLE_SALVAGE_WRITER,
  SALVAGE_WRITER_LOCAL_TAG,
  SALVAGE_WRITER_UPSTREAM,
  STORE_GENERATIONS_KEPT,
  STORE_PRUNE_UNTIL,
} from '#features/images/image-promoter'

const execFileAsync = promisify(execFile)
const SID = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
const TAR = `.salvage-${SID}.tar`
const POD = 'yaac-salvage-aaaabbbb'
const HEX = 'a'.repeat(64)
const HEX2 = 'b'.repeat(64)

const PARAMS = { jobName: 'yaac-demo-job', projectSlug: 'demo', sessionId: SID }

/** Run one salvage whose in-session survey reports `stdout`. */
async function salvageReporting(stdout: string): Promise<void> {
  mockContainerExec.mockResolvedValue({ stdout, stderr: '' })
  await expect(salvageSessionImages(PARAMS)).resolves.toBe(true)
}

/** The sudo-wrapped survey command handed to the session container. */
const surveyCommand = (): string => mockContainerExec.mock.calls[0][1] as string

type ExecCall = [string[], { input?: string }?]
const writerExec = (): [string[], { input?: string }] =>
  (mockKubectlWithRetry.mock.calls as ExecCall[])
    .find(([args]) => args[0] === 'exec') as [string[], { input?: string }]

interface WriterPod {
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  spec: {
    runtimeClassName?: string
    restartPolicy: string
    activeDeadlineSeconds: number
    containers: Array<{ image: string; command: string[] }>
    volumes: Array<{ hostPath: { path: string } }>
  }
}
const writerPod = (): WriterPod => mockKubectlApply.mock.calls[0][0] as WriterPod

/** A survey report that saves two images, one of them dangling. */
const TWO_SAVED = `img sha256:${HEX} localhost/myapp:v1\nimg ${HEX2} <none>:<none>\nsaved 2\n`

beforeEach(() => {
  mockContainerExec.mockReset()
  // The writer pod's exec reports its post-load store size; harmless for
  // the paths that never spawn a writer.
  mockKubectlWithRetry.mockReset().mockResolvedValue({ stdout: 'store-images 5', stderr: '' })
  mockKubectlApply.mockReset().mockResolvedValue(undefined)
  mockRegistryHasTag.mockReset().mockResolvedValue(true)
})

describe('salvageSessionImages', () => {
  it('self-gates on the store mount and podman, and hands off the tar via an atomic rename', async () => {
    await salvageReporting('')
    const cmd = surveyCommand()
    expect(cmd).toContain('[ -d /var/lib/shared-images-dst ] || exit 0')
    expect(cmd).toContain('command -v podman >/dev/null 2>&1 || exit 0')
    // Atomic handoff: the writer must never load a half-written tar.
    expect(cmd).toContain(`.salvage-${SID}.tar.partial`)
    expect(cmd).toContain(`mv /var/lib/shared-images-dst/${TAR}.partial`)
    // Diffs against the store through the read-only additional-store
    // mount — no writer pod is spawned when there is nothing to save.
    expect(cmd).toContain('/var/lib/shared-images/overlay-images')
  })

  it('gates on usable passwordless sudo before the sudo-run script', async () => {
    await salvageReporting('')
    const cmd = surveyCommand()
    expect(cmd).toContain('command -v sudo >/dev/null 2>&1 || exit 0')
    expect(cmd).toContain('sudo -n true 2>/dev/null || exit 0')
    expect(cmd).toContain('exec sudo -n -H sh -c ')
  })

  it('sends valid POSIX shell into the session', async () => {
    await salvageReporting('')
    await expect(execFileAsync('sh', ['-n', '-c', surveyCommand()])).resolves.toBeTruthy()
  })

  it('is a single self-gated exec when the engine reports nothing', async () => {
    await salvageReporting('')
    expect(mockContainerExec).toHaveBeenCalledOnce()
    expect(mockKubectlApply).not.toHaveBeenCalled()
  })

  it('forwards parsed id/ref pairs to the writer, stripping sha256: prefixes', async () => {
    mockKubectlWithRetry.mockResolvedValue({ stdout: 'store-images 5', stderr: '' })
    await salvageReporting(TWO_SAVED)
    // Only the tagged row rides argv; the dangling row is loaded but has
    // no tag to apply.
    expect(writerExec()[0].slice(-2)).toEqual([HEX, 'localhost/myapp:v1'])
  })

  it('drops malformed ids and refs — nothing unvalidated reaches the writer', async () => {
    mockKubectlWithRetry.mockResolvedValue({ stdout: 'store-images 5', stderr: '' })
    // A bad-id row is dropped entirely; a shell-metachar ref is dropped
    // while its (valid) id is kept, so it loads untagged.
    await salvageReporting(`img not-an-id some:ref\nimg ${HEX2} $(rm~-rf~/)\nsaved 1\n`)
    const argv = writerExec()[0]
    expect(argv.join(' ')).not.toContain('not-an-id')
    expect(argv.join(' ')).not.toContain('rm~-rf~')
  })

  it('skips the writer when nothing was saved and no tags are pending', async () => {
    await salvageReporting(`img ${HEX2}\nsaved 0\n`)
    expect(mockKubectlApply).not.toHaveBeenCalled()
  })

  it('runs on runc (no RuntimeClass) with the store hostPath and a deadline', async () => {
    await salvageReporting(TWO_SAVED)
    const pod = writerPod()
    expect(pod.metadata.name).toBe(POD)
    expect(pod.metadata.namespace).toBe('test-ns')
    expect(pod.metadata.labels['yaac.role']).toBe(ROLE_SALVAGE_WRITER)
    // Trusted infra on runc: native file extraction is the whole point,
    // and the digest-pinned upstream image never runs user-influenced
    // binaries (the session image must NOT be used here).
    expect(pod.spec.runtimeClassName).toBeUndefined()
    expect(pod.spec.restartPolicy).toBe('Never')
    expect(pod.spec.activeDeadlineSeconds).toBe(1800)
    expect(pod.spec.containers[0].image).toBe(`localhost:5001/${SALVAGE_WRITER_LOCAL_TAG}`)
    expect(pod.spec.containers[0].command).toEqual(['sleep', 'infinity'])
    expect(pod.spec.volumes[0].hostPath.path)
      .toBe('/var/lib/yaac/imagecache/ddh16chars000000/demo')
  })

  it('deletes the writer pod without waiting on it', async () => {
    await salvageReporting(TWO_SAVED)
    const deleteCall = (mockKubectlWithRetry.mock.calls as ExecCall[]).find(([a]) =>
      a[0] === 'delete' && a.includes(POD) && a.includes('--wait=false'))
    expect(deleteCall).toBeDefined()
  })

  it('loads the tar under the store flock, tags from argv pairs, GCs, sweeps stale tars', async () => {
    await salvageReporting(TWO_SAVED)
    const script = writerExec()[1].input!
    expect(script).toContain(`load -i /store/${TAR}`)
    expect(script).toContain(`rm -f /store/${TAR}`)
    expect(script).toContain('while [ "$#" -ge 2 ]')
    expect(script).toContain('tag "$1" "$2"')
    expect(script).toContain(
      `image prune --filter dangling=true --filter until=${STORE_PRUNE_UNTIL} -f`,
    )
    expect(script).toContain('-name ".salvage-*.tar*" -mmin +60 -delete')
  })

  it('retires tags past the per-repo generation budget before the prune', async () => {
    await salvageReporting(TWO_SAVED)
    const script = writerExec()[1].input!
    // --sort created is newest-first, so rows past the budget are the
    // stale generations; dangling rows (<none>) are never candidates.
    expect(script).toContain('image ls --sort created')
    expect(script).toContain(`awk -v keep=${STORE_GENERATIONS_KEPT} '$1 != "<none>"`)
    expect(script).toContain('rmi "$stale"')
    // Retirement must precede the dangling prune that cascades it.
    expect(script.indexOf('rmi "$stale"')).toBeLessThan(script.indexOf('image prune'))
  })

  it('sends valid POSIX shell into the writer', async () => {
    await salvageReporting(TWO_SAVED)
    await expect(execFileAsync('sh', ['-n', '-c', writerExec()[1].input!])).resolves.toBeTruthy()
  })

  it('swallows failures — teardown is never blocked on cache salvage', async () => {
    mockContainerExec.mockRejectedValue(new Error('pod is gone'))
    await expect(salvageSessionImages(PARAMS)).resolves.toBe(false)
  })

  it('coalesces concurrent salvages for the same session', async () => {
    let resolveExec: (v: { stdout: string; stderr: string }) => void = () => {}
    mockContainerExec.mockReturnValue(new Promise((r) => { resolveExec = r }))
    const a = salvageSessionImages(PARAMS)
    const b = salvageSessionImages(PARAMS)
    resolveExec({ stdout: '', stderr: '' })
    await expect(Promise.all([a, b])).resolves.toEqual([true, true])
    expect(mockContainerExec).toHaveBeenCalledOnce()
  })
})

describe('sharedImageStoreHostPath', () => {
  it('keys the node-local store by data-dir hash and project slug', () => {
    expect(sharedImageStoreHostPath('my-proj'))
      .toBe('/var/lib/yaac/imagecache/ddh16chars000000/my-proj')
  })

  it('separates projects', () => {
    expect(sharedImageStoreHostPath('proj-a')).not.toBe(sharedImageStoreHostPath('proj-b'))
  })
})

describe('ensureSalvageWriterImage', () => {
  it('returns the registry ref without pulling when the tag is mirrored', async () => {
    mockRegistryHasTag.mockResolvedValue(true)
    await expect(ensureSalvageWriterImage(true))
      .resolves.toBe(`localhost:5001/${SALVAGE_WRITER_LOCAL_TAG}`)
  })

  it('is digest-pinned upstream (the digest IS the pin — no content hash)', () => {
    expect(SALVAGE_WRITER_UPSTREAM).toMatch(/^quay\.io\/podman\/stable@sha256:[0-9a-f]{64}$/)
  })
})
