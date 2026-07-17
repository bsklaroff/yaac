import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type * as execModule from '#lib/k8s/exec'
import type * as kubectlModule from '#lib/k8s/kubectl'
import type * as registryModule from '#lib/k8s/registry'

const mockContainerExec = vi.hoisted(() => vi.fn())
vi.mock('#lib/k8s/exec', async (importOriginal) => ({
  ...(await importOriginal<typeof execModule>()),
  containerExec: mockContainerExec,
}))

const mockKubectlWithRetry = vi.hoisted(() => vi.fn())
const mockKubectlApply = vi.hoisted(() => vi.fn())
vi.mock('#lib/k8s/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'test-ns',
  dataDirHash: () => 'ddh16chars000000',
  kubectlWithRetry: mockKubectlWithRetry,
  kubectlApply: mockKubectlApply,
}))

const mockRegistryHasTag = vi.hoisted(() => vi.fn())
vi.mock('#lib/k8s/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof registryModule>()),
  registryHasTag: mockRegistryHasTag,
  registryRef: (tag: string) => `localhost:5001/${tag}`,
  pushImageToRegistry: vi.fn(),
}))

vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))

import {
  buildSalvageWriterPodManifest,
  buildSurveyScript,
  buildWriterScript,
  ensureSalvageWriterImage,
  parseSurveyReport,
  ROLE_SALVAGE_WRITER,
  SALVAGE_WRITER_LOCAL_TAG,
  SALVAGE_WRITER_UPSTREAM,
  salvageSessionImages,
  salvageTarName,
  salvageWriterPodName,
  sharedImageStoreHostPath,
  STORE_GENERATIONS_KEPT,
  STORE_PRUNE_UNTIL,
  surveyExecCommand,
} from '#lib/container/image-promoter'

const execFileAsync = promisify(execFile)
const SID = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
const HEX = 'a'.repeat(64)
const HEX2 = 'b'.repeat(64)

beforeEach(() => {
  mockContainerExec.mockReset()
  mockKubectlWithRetry.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  mockKubectlApply.mockReset().mockResolvedValue(undefined)
  mockRegistryHasTag.mockReset().mockResolvedValue(true)
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

describe('salvage names', () => {
  it('derives tar and writer-pod names from the session id', () => {
    expect(salvageTarName(SID)).toBe(`.salvage-${SID}.tar`)
    expect(salvageWriterPodName(SID)).toBe('yaac-salvage-aaaabbbb')
  })
})

describe('parseSurveyReport', () => {
  it('parses img rows and the saved count, stripping sha256: prefixes', () => {
    const { images, savedCount } = parseSurveyReport(
      `img sha256:${HEX} localhost/myapp:v1\nimg ${HEX2} <none>:<none>\nsaved 2\n`,
    )
    expect(images).toEqual([
      { id: HEX, ref: 'localhost/myapp:v1' },
      { id: HEX2, ref: null },
    ])
    expect(savedCount).toBe(2)
  })

  it('drops malformed ids and refs — nothing unvalidated reaches the writer', () => {
    const { images } = parseSurveyReport(
      `img not-an-id some:ref\nimg ${HEX2} $(rm~-rf~/)\nnoise line\n`,
    )
    // The bad-id row is dropped entirely; the shell-metachar ref is
    // dropped while its (valid) id is kept.
    expect(images).toEqual([{ id: HEX2, ref: null }])
  })

  it('returns empty for a self-gated (silent) report', () => {
    expect(parseSurveyReport('')).toEqual({ images: [], savedCount: 0 })
  })
})

describe('buildSurveyScript / surveyExecCommand', () => {
  it('self-gates on the store mount and podman, and hands off the tar via an atomic rename', () => {
    const script = buildSurveyScript(SID)
    expect(script).toContain('[ -d /var/lib/shared-images-dst ] || exit 0')
    expect(script).toContain('command -v podman >/dev/null 2>&1 || exit 0')
    // Atomic handoff: the writer must never load a half-written tar.
    expect(script).toContain(`.salvage-${SID}.tar.partial`)
    expect(script).toContain(`mv /var/lib/shared-images-dst/${salvageTarName(SID)}.partial`)
    // Diffs against the store through the read-only additional-store
    // mount — no writer pod is spawned when there is nothing to save.
    expect(script).toContain('/var/lib/shared-images/overlay-images')
  })

  it('gates on usable passwordless sudo before the sudo-run script', () => {
    const cmd = surveyExecCommand(SID)
    expect(cmd).toContain('command -v sudo >/dev/null 2>&1 || exit 0')
    expect(cmd).toContain('sudo -n true 2>/dev/null || exit 0')
    expect(cmd).toContain('exec sudo -n -H sh -c ')
  })

  it('is valid POSIX shell, as is the exec command wrapping it', async () => {
    await expect(execFileAsync('sh', ['-n', '-c', buildSurveyScript(SID)])).resolves.toBeTruthy()
    await expect(execFileAsync('sh', ['-n', '-c', surveyExecCommand(SID)])).resolves.toBeTruthy()
  })
})

describe('buildSalvageWriterPodManifest', () => {
  it('runs on runc (no RuntimeClass) with the store hostPath and a deadline', () => {
    const m = buildSalvageWriterPodManifest('demo', SID, 'localhost:5001/podman-stable:v5.5') as {
      metadata: { name: string; namespace: string; labels: Record<string, string> }
      spec: {
        runtimeClassName?: string
        restartPolicy: string
        activeDeadlineSeconds: number
        containers: Array<{ image: string; command: string[] }>
        volumes: Array<{ hostPath: { path: string } }>
      }
    }
    expect(m.metadata.name).toBe('yaac-salvage-aaaabbbb')
    expect(m.metadata.namespace).toBe('test-ns')
    expect(m.metadata.labels['yaac.role']).toBe(ROLE_SALVAGE_WRITER)
    // Trusted infra on runc: native file extraction is the whole point,
    // and the digest-pinned upstream image never runs user-influenced
    // binaries (the session image must NOT be used here).
    expect(m.spec.runtimeClassName).toBeUndefined()
    expect(m.spec.restartPolicy).toBe('Never')
    expect(m.spec.activeDeadlineSeconds).toBe(1800)
    expect(m.spec.containers[0].image).toBe('localhost:5001/podman-stable:v5.5')
    expect(m.spec.containers[0].command).toEqual(['sleep', 'infinity'])
    expect(m.spec.volumes[0].hostPath.path).toBe('/var/lib/yaac/imagecache/ddh16chars000000/demo')
  })
})

describe('buildWriterScript', () => {
  it('loads the tar under the store flock, tags from argv pairs, GCs, sweeps stale tars', () => {
    const script = buildWriterScript(SID)
    expect(script).toContain(`load -i /store/${salvageTarName(SID)}`)
    expect(script).toContain(`rm -f /store/${salvageTarName(SID)}`)
    expect(script).toContain('while [ "$#" -ge 2 ]')
    expect(script).toContain('tag "$1" "$2"')
    expect(script).toContain(
      `image prune --filter dangling=true --filter until=${STORE_PRUNE_UNTIL} -f`,
    )
    expect(script).toContain('-name ".salvage-*.tar*" -mmin +60 -delete')
  })

  it('retires tags past the per-repo generation budget before the prune', () => {
    const script = buildWriterScript(SID)
    // --sort created is newest-first, so rows past the budget are the
    // stale generations; dangling rows (<none>) are never candidates.
    expect(script).toContain('image ls --sort created')
    expect(script).toContain(`awk -v keep=${STORE_GENERATIONS_KEPT} '$1 != "<none>"`)
    expect(script).toContain('rmi "$stale"')
    // Retirement must precede the dangling prune that cascades it.
    expect(script.indexOf('rmi "$stale"')).toBeLessThan(script.indexOf('image prune'))
  })

  it('is valid POSIX shell', async () => {
    await expect(execFileAsync('sh', ['-n', '-c', buildWriterScript(SID)])).resolves.toBeTruthy()
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

describe('salvageSessionImages', () => {
  const params = { jobName: 'yaac-demo-job', projectSlug: 'demo', sessionId: SID }

  it('is a single self-gated exec when the engine reports nothing', async () => {
    mockContainerExec.mockResolvedValue({ stdout: '', stderr: '' })
    await expect(salvageSessionImages(params)).resolves.toBe(true)
    expect(mockContainerExec).toHaveBeenCalledOnce()
    expect(mockKubectlApply).not.toHaveBeenCalled()
  })

  it('skips the writer when nothing was saved and no tags are pending', async () => {
    mockContainerExec.mockResolvedValue({ stdout: `img ${HEX2}\nsaved 0\n`, stderr: '' })
    await expect(salvageSessionImages(params)).resolves.toBe(true)
    expect(mockKubectlApply).not.toHaveBeenCalled()
  })

  it('spawns the writer, passes validated tag pairs as argv, and deletes the pod', async () => {
    mockContainerExec.mockResolvedValue({
      stdout: `img ${HEX} localhost/myapp:v1\nimg ${HEX2} <none>:<none>\nsaved 2\n`,
      stderr: '',
    })
    mockKubectlWithRetry.mockResolvedValue({ stdout: 'store-images 5', stderr: '' })
    await expect(salvageSessionImages(params)).resolves.toBe(true)

    expect(mockKubectlApply).toHaveBeenCalledOnce()
    const allCalls = mockKubectlWithRetry.mock.calls as Array<[string[], { input?: string }?]>
    const execCall = allCalls.find(([args]) => args[0] === 'exec')
    expect(execCall).toBeDefined()
    const [args, opts] = execCall! as [string[], { input?: string }]
    expect(args).toContain('pod/yaac-salvage-aaaabbbb')
    // Tag pairs ride argv directly — no shell quoting layer to escape.
    expect(args.slice(-2)).toEqual([HEX, 'localhost/myapp:v1'])
    expect(opts.input).toContain('load -i')

    const calls = mockKubectlWithRetry.mock.calls as Array<[string[]]>
    const deleteCall = calls.find(([a]) =>
      a[0] === 'delete' && a.includes('yaac-salvage-aaaabbbb') && a.includes('--wait=false'))
    expect(deleteCall).toBeDefined()
  })

  it('swallows failures — teardown is never blocked on cache salvage', async () => {
    mockContainerExec.mockRejectedValue(new Error('pod is gone'))
    await expect(salvageSessionImages(params)).resolves.toBe(false)
  })

  it('coalesces concurrent salvages for the same session', async () => {
    let resolveExec: (v: { stdout: string; stderr: string }) => void = () => {}
    mockContainerExec.mockReturnValue(new Promise((r) => { resolveExec = r }))
    const a = salvageSessionImages(params)
    const b = salvageSessionImages(params)
    resolveExec({ stdout: '', stderr: '' })
    await expect(Promise.all([a, b])).resolves.toEqual([true, true])
    expect(mockContainerExec).toHaveBeenCalledOnce()
  })
})
