/**
 * The push side of the nested-container image cache, tested through
 * `salvageJobImages`. The survey script, report parser, push planner and
 * retire script are checked as they are wired together.
 *
 * The registry-ranking fragment this module also exports is covered in
 * store-writer.test.ts, where its consumer runs it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type * as execModule from '#drivers/k8s/substrate/exec'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'

const mockContainerExec = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/exec', async (importOriginal) => ({
  ...(await importOriginal<typeof execModule>()),
  containerExec: mockContainerExec,
}))

vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'test-ns',
  dataDirHash: () => 'ddh16chars000000',
}))

vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))

import { salvageJobImages } from '#drivers/k8s/images'
// The project registry host is resolved for real, not stubbed.
import { projectRegistryHost } from '#drivers/k8s/cluster'
import {
  CACHE_TAG_PREFIX,
  _resetSalvageMemoForTests,
} from '#drivers/k8s/images/image-promoter'

const execFileAsync = promisify(execFile)
const SID = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
const HEX = 'a'.repeat(64)
const HEX2 = 'b'.repeat(64)
const HEX3 = 'c'.repeat(64)

const PROJECT = { slug: 'demo', id: '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c' }
const PARAMS = { jobName: 'yaac-demo-job', project: PROJECT, workspaceId: SID }
const REG = projectRegistryHost(PROJECT.id)

/** A three-image engine: a named leaf on two unnamed ancestors. */
const CHAIN =
  `img sha256:${HEX}|sha256:${HEX2}|localhost/myapp:v1,\n`
  + `img sha256:${HEX2}|sha256:${HEX3}|\n`
  + `img sha256:${HEX3}||\n`

/** Run one salvage whose in-pod survey reports `stdout`. */
async function salvageReporting(stdout: string): Promise<boolean> {
  mockContainerExec.mockImplementation((_job: string, cmd: string) =>
    Promise.resolve(cmd.includes('image inspect')
      ? { stdout, stderr: '' }
      : { stdout: 'pushed 1 failed 0\n', stderr: '' }))
  return salvageJobImages(PARAMS)
}

/** The sudo-wrapped commands run in the workspace container, in order. */
const commands = (): string[] => mockContainerExec.mock.calls.map((c) => c[1] as string)
const surveyCommand = (): string => commands()[0]
/** The push command with one layer of `sh -c` quoting removed. */
const pushCommand = (): string => commands()[1].replace(/'\\''/g, "'")

beforeEach(() => {
  mockContainerExec.mockReset()
  _resetSalvageMemoForTests()
})

describe('salvageJobImages', () => {
  it('gates on the in-pod engine and passwordless sudo, and stays one exec with nothing to push', async () => {
    await expect(salvageReporting('')).resolves.toBe(true)
    const cmd = surveyCommand()
    expect(cmd).toContain('command -v sudo >/dev/null 2>&1 || exit 0')
    expect(cmd).toContain('sudo -n true 2>/dev/null || exit 0')
    expect(cmd).toContain('exec sudo -n -H sh -c ')
    // Checks the engine marker, not `command -v podman`: a pod can have the
    // binary but no engine. The check must come before sudo, since an
    // unconfigured podman run as root creates a root-owned directory in the
    // cwd, which is the user's checkout.
    expect(cmd).toContain('[ "${YAAC_NESTED_ENGINE:-}" = 1 ] || exit 0')
    expect(cmd.indexOf('YAAC_NESTED_ENGINE')).toBeLessThan(cmd.indexOf('sudo'))
    expect(cmd).not.toContain('command -v podman')
    // No push exec when nothing is new.
    expect(mockContainerExec).toHaveBeenCalledOnce()
  })

  it('never pushes back what the node image store already provided', async () => {
    // A warm workspace: the store's base chain is read-only, with one
    // image the workspace built on top of it.
    await expect(salvageReporting(
      `ro sha256:${HEX2}\n`
      + `ro sha256:${HEX3}\n`
      + CHAIN,
    )).resolves.toBe(true)
    const push = pushCommand()
    // The workspace's own image is pushed under its name.
    expect(push).toContain(`'${HEX}' '${REG}/myapp:v1'`)
    // Its ancestors came from the store, which is a copy of this registry,
    // so the chain walk stops at the first one.
    expect(push).not.toContain(HEX2)
    expect(push).not.toContain(CACHE_TAG_PREFIX)
    // No retire either. Retiring assumes the whole chain 1..depth was just
    // pushed; after an early stop the chain continues in the registry, and
    // retiring would permanently delete the shared prefix.
    expect(commands()).toHaveLength(2)
  })

  it('reports which images exist only in the read-only store', async () => {
    await expect(salvageReporting('')).resolves.toBe(true)
    const cmd = surveyCommand()
    // An id the workspace also holds writably (it re-tagged a store image)
    // is not read-only, since that name is new.
    expect(cmd).toContain('{{.ID}} {{.ReadOnly}}')
    expect(cmd).toContain('if ($2 == "false") w[$1] = 1')
    expect(cmd).toContain('if (!(i in w)) print "ro " i')
    await expect(execFileAsync('sh', ['-n', '-c', cmd])).resolves.toBeTruthy()
  })

  it('pushes named images under their own name, ancestors as bounded cache tags', async () => {
    await expect(salvageReporting(CHAIN)).resolves.toBe(true)
    const push = pushCommand()
    // gzip, because zstd would silently convert a docker-schema2 image to
    // OCI, and buildah only uses cache entries matching the build's format
    // (schema2 via the Docker CLI). Level 1 and nice, because it runs in the
    // workspace sandbox and must not compete with the agent for CPU.
    expect(push).toContain('nice -n 19 podman push --tls-verify=false '
      + '--compression-format gzip --compression-level 1 "$1" "$2"')
    // `id dest` pairs: the named image first, then its ancestors under tags
    // derived from its tag, so a rebuild overwrites them rather than adding
    // more.
    const pairs = push.match(/'[0-9a-f]{64}' '[^']+'/g) ?? []
    expect(pairs).toEqual([
      `'${HEX}' '${REG}/myapp:v1'`,
      `'${HEX2}' '${REG}/myapp:${CACHE_TAG_PREFIX}v1-1'`,
      `'${HEX3}' '${REG}/myapp:${CACHE_TAG_PREFIX}v1-2'`,
    ])
  })

  it('canonicalizes podman local names, so one image is never two repos', async () => {
    // podman reports unqualified names with a `localhost/` prefix, while
    // the server pushes bare tags. Keeping the prefix would put each image
    // in the registry twice, with no shared layer blobs.
    await expect(salvageReporting(
      `img sha256:${HEX}||localhost/myapp:v1,docker.io/library/alpine:3.20,\n`,
    )).resolves.toBe(true)
    const push = pushCommand()
    expect(push).not.toContain('localhost/')
    // A registry-qualified ref keeps its host, since that is the name the
    // workspace uses.
    expect(push).toContain(`'${HEX}' '${REG}/docker.io/library/alpine:3.20'`)
    expect(push).toContain(`'${HEX}' '${REG}/myapp:v1'`)
  })

  it('leaves a port-qualified host alone and drops what stays prefixed', async () => {
    // The prefix match includes the slash, so `localhost:5000/…` (a real
    // registry) is not mangled. `localhost/localhost/foo` still has the
    // prefix after one strip, and stripping twice would rename the image,
    // so it is dropped.
    await expect(salvageReporting(
      `img sha256:${HEX}||localhost:5000/foo:v1,\n`
      + `img sha256:${HEX2}||localhost/localhost/foo:v1,\n`
      + `img sha256:${HEX3}||localhost/keeper:v1,\n`,
    )).resolves.toBe(true)
    const pairs = pushCommand().match(/'[0-9a-f]{64}' '[^']+'/g) ?? []
    expect(pairs).toEqual([`'${HEX3}' '${REG}/keeper:v1'`])
  })

  it('skips what the pod already put in the registry — a prime never bounces back', async () => {
    // The ledger lists what was pulled into the pod or already pushed, so
    // only the remaining ancestor is pushed. This relies on the survey's
    // `localhost/` names mapping back to the recorded destinations.
    const have = `have ${HEX} ${REG}/myapp:v1\n`
      + `have ${HEX2} ${REG}/myapp:${CACHE_TAG_PREFIX}v1-1\n`
    await expect(salvageReporting(have + CHAIN)).resolves.toBe(true)
    const pairs = pushCommand().match(/'[0-9a-f]{64}' '[^']+'/g) ?? []
    expect(pairs).toEqual([`'${HEX3}' '${REG}/myapp:${CACHE_TAG_PREFIX}v1-2'`])
  })

  it('re-salvages a rebuilt tag — the ledger keys on the id, not the name', async () => {
    // Same destination, new image id, so it is pushed.
    const have = `have ${HEX} ${REG}/myapp:v1\n`
    const rebuilt = `img sha256:${HEX3}||localhost/myapp:v1,\n`
    await expect(salvageReporting(have + rebuilt)).resolves.toBe(true)
    expect(pushCommand()).toContain(`'${HEX3}' '${REG}/myapp:v1'`)
  })

  it('retires stale slots even when there is nothing left to push', async () => {
    // Otherwise a crash between push and retire would leave stale tags
    // forever, since later salvages find nothing to push.
    const have = `have ${HEX} ${REG}/myapp:v1\n`
      + `have ${HEX2} ${REG}/myapp:${CACHE_TAG_PREFIX}v1-1\n`
      + `have ${HEX3} ${REG}/myapp:${CACHE_TAG_PREFIX}v1-2\n`
    await expect(salvageReporting(have + CHAIN)).resolves.toBe(true)
    expect(mockContainerExec).toHaveBeenCalledTimes(2)
    expect(commands()[1]).toContain('retired')
  })

  it('retries the retire when a DELETE failed — a 405 must not mark it done', async () => {
    const have = `have ${HEX} ${REG}/myapp:v1\n`
      + `have ${HEX2} ${REG}/myapp:${CACHE_TAG_PREFIX}v1-1\n`
      + `have ${HEX3} ${REG}/myapp:${CACHE_TAG_PREFIX}v1-2\n`
    // The registry refuses DELETE while a GC holds it read-only.
    mockContainerExec.mockImplementation((_job: string, cmd: string) =>
      Promise.resolve(cmd.includes('image inspect')
        ? { stdout: have + CHAIN, stderr: '' }
        : { stdout: 'retired 0 failed 2\n', stderr: '' }))
    await salvageJobImages(PARAMS)
    mockContainerExec.mockClear()
    await salvageJobImages(PARAMS)
    // The second cycle tries again.
    expect(mockContainerExec).toHaveBeenCalledTimes(2)
  })

  it('stops re-retiring once the chain shape is unchanged', async () => {
    const have = `have ${HEX} ${REG}/myapp:v1\n`
      + `have ${HEX2} ${REG}/myapp:${CACHE_TAG_PREFIX}v1-1\n`
      + `have ${HEX3} ${REG}/myapp:${CACHE_TAG_PREFIX}v1-2\n`
    await salvageReporting(have + CHAIN)
    mockContainerExec.mockClear()
    // Same chain shape: back to a single exec.
    await salvageReporting(have + CHAIN)
    expect(mockContainerExec).toHaveBeenCalledOnce()
  })

  it('retires chain slots a shorter rebuild no longer fills', async () => {
    await expect(salvageReporting(CHAIN)).resolves.toBe(true)
    // After the push: delete tags upward from depth+1 until one is missing.
    const retire = commands()[2].replace(/'\\''/g, "'")
    expect(retire).toContain(`'myapp' 'v1' '2'`)
    expect(retire).toContain('-X DELETE "http://$REG/v2/$repo/manifests/$dg"')
    expect(retire).toContain('[ -n "$dg" ] || break')
    // Failures are counted so the retire is retried (see above).
    expect(retire).toContain('echo "retired $n failed $f"')
  })

  it('drops malformed rows and refs that are already registry copies', async () => {
    await expect(salvageReporting(
      'img not-an-id|| localhost/bad:v1,\n'
      + `img sha256:${HEX}||$(rm~-rf~/):v1,${REG}/localhost/pulled:v1,\n`,
    )).resolves.toBe(true)
    // The bad id, the shell-metachar ref and the registry-hosted ref are
    // all dropped.
    expect(mockContainerExec).toHaveBeenCalledOnce()
  })

  it('sends valid POSIX shell into the session, both legs', async () => {
    await salvageReporting(CHAIN)
    for (const cmd of commands()) {
      await expect(execFileAsync('sh', ['-n', '-c', cmd])).resolves.toBeTruthy()
    }
  })

  it('swallows failures — teardown is never blocked on cache salvage', async () => {
    mockContainerExec.mockRejectedValue(new Error('pod is gone'))
    await expect(salvageJobImages(PARAMS)).resolves.toBe(false)
  })

  it('coalesces concurrent salvages for the same session', async () => {
    let resolveExec: (v: { stdout: string; stderr: string }) => void = () => {}
    mockContainerExec.mockReturnValue(new Promise((r) => { resolveExec = r }))
    const a = salvageJobImages(PARAMS)
    const b = salvageJobImages(PARAMS)
    resolveExec({ stdout: '', stderr: '' })
    await expect(Promise.all([a, b])).resolves.toEqual([true, true])
    expect(mockContainerExec).toHaveBeenCalledOnce()
  })
})
