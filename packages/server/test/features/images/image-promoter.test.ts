/**
 * The nested-session image cache, exercised through its two barrel entries:
 * `salvageSessionImages` (push into the project registry) and
 * `primeSessionImages` (pull back into a fresh session's engine).
 *
 * The survey script, its sudo wrapper, the report parser, the push planner
 * and the two in-pod scripts are all things the salvage hands to a session
 * pod on the way through one teardown or one create. Driving the barrel
 * entries rather than each generator means the pieces are checked as they
 * are actually wired — a parser that silently stops feeding the planner, or
 * a script that stops being reachable, fails here instead of staying green
 * in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type * as execModule from '#platform/k8s/exec'
import type * as kubectlModule from '#platform/k8s/kubectl'

const mockContainerExec = vi.hoisted(() => vi.fn())
vi.mock('#platform/k8s/exec', async (importOriginal) => ({
  ...(await importOriginal<typeof execModule>()),
  containerExec: mockContainerExec,
}))

vi.mock('#platform/k8s/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'test-ns',
  dataDirHash: () => 'ddh16chars000000',
}))

vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))

import { primeSessionImages, salvageSessionImages } from '#features/images'
// The registry the cache rides is the project's own — resolved for real
// here (not stubbed), so a change to its host shape shows up as a broken
// push destination rather than a passing test against a stale constant.
import { projectRegistryHost } from '#features/cluster'
import { CACHE_TAG_PREFIX, _resetSalvageMemoForTests } from '#features/images/image-promoter'

const execFileAsync = promisify(execFile)
const SID = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
const HEX = 'a'.repeat(64)
const HEX2 = 'b'.repeat(64)
const HEX3 = 'c'.repeat(64)

const PARAMS = { jobName: 'yaac-demo-job', projectSlug: 'demo', sessionId: SID }
const REG = projectRegistryHost('demo')

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
  return salvageSessionImages(PARAMS)
}

/** The sudo-wrapped commands handed to the session container, in order. */
const commands = (): string[] => mockContainerExec.mock.calls.map((c) => c[1] as string)
const surveyCommand = (): string => commands()[0]
/** The push exec with one layer of `sh -c` quoting peeled off, so the
 *  `'id' 'dest'` argv pairs read as written. */
const pushCommand = (): string => commands()[1].replace(/'\\''/g, "'")

beforeEach(() => {
  mockContainerExec.mockReset()
  _resetSalvageMemoForTests()
})

describe('salvageSessionImages', () => {
  it('gates on podman and passwordless sudo, and stays one exec with nothing to push', async () => {
    await expect(salvageReporting('')).resolves.toBe(true)
    const cmd = surveyCommand()
    expect(cmd).toContain('command -v sudo >/dev/null 2>&1 || exit 0')
    expect(cmd).toContain('sudo -n true 2>/dev/null || exit 0')
    expect(cmd).toContain('exec sudo -n -H sh -c ')
    expect(cmd).toContain('command -v podman >/dev/null 2>&1 || exit 0')
    // The survey only reads metadata — no push exec when nothing is new.
    expect(mockContainerExec).toHaveBeenCalledOnce()
  })

  it('pushes named images under their own name, ancestors as bounded cache tags', async () => {
    await expect(salvageReporting(CHAIN)).resolves.toBe(true)
    const push = pushCommand()
    // zstd:1 and a nice'd push: this compression runs inside the session
    // sandbox, so total CPU is the budget (measured on a 576MB layer of
    // real binaries: 20.6s -> 16.3s CPU pushing, and the prime-side pull
    // 15.2s -> 9.5s), and background work must lose to the agent.
    expect(push).toContain('nice -n 19 podman push --tls-verify=false '
      + '--compression-format zstd --compression-level 1 "$1" "$2"')
    // argv is `id dest` pairs: the named image first (its blobs land in the
    // repo the chain entries then reuse), then the ancestor chain under
    // tags derived from the named tag — so a rebuilt myapp:v1 overwrites
    // them instead of growing a generation per session.
    const pairs = push.match(/'[0-9a-f]{64}' '[^']+'/g) ?? []
    expect(pairs).toEqual([
      `'${HEX}' '${REG}/myapp:v1'`,
      `'${HEX2}' '${REG}/myapp:${CACHE_TAG_PREFIX}v1-1'`,
      `'${HEX3}' '${REG}/myapp:${CACHE_TAG_PREFIX}v1-2'`,
    ])
  })

  it('canonicalizes podman local names, so one image is never two repos', async () => {
    // The engine reports every non-registry-qualified name under podman's
    // `localhost/` prefix, while everything the server pushes into this
    // same registry uses the bare tag. Pushing the prefix verbatim put
    // each shared image in the catalog twice — and the copies share no
    // LAYER blobs, since the salvage compresses zstd where the host wrote
    // gzip.
    await expect(salvageReporting(
      `img sha256:${HEX}||localhost/myapp:v1,docker.io/library/alpine:3.20,\n`,
    )).resolves.toBe(true)
    const push = pushCommand()
    expect(push).not.toContain('localhost/')
    // A registry-qualified ref keeps its host: that IS the name a session
    // pulls it by, and the prime side has to restore it intact.
    expect(push).toContain(`'${HEX}' '${REG}/docker.io/library/alpine:3.20'`)
    expect(push).toContain(`'${HEX}' '${REG}/myapp:v1'`)
  })

  it('leaves a port-qualified host alone and drops what stays prefixed', async () => {
    // The prefix match is anchored on the SLASH. `localhost:5000/…` is a
    // real registry — this install's own local one — and a predicate that
    // matched the bare word would slice its host into a `000/foo`
    // destination while every other test here stayed green.
    // `localhost/localhost/foo` is what podman reports for an image tagged
    // that way (it does not collapse the repeat); its canonical form still
    // carries the prefix, and stripping twice would rename someone's
    // image, so it is dropped like any other ref with no name to push it
    // under.
    await expect(salvageReporting(
      `img sha256:${HEX}||localhost:5000/foo:v1,\n`
      + `img sha256:${HEX2}||localhost/localhost/foo:v1,\n`
      + `img sha256:${HEX3}||localhost/keeper:v1,\n`,
    )).resolves.toBe(true)
    const pairs = pushCommand().match(/'[0-9a-f]{64}' '[^']+'/g) ?? []
    expect(pairs).toEqual([`'${HEX3}' '${REG}/keeper:v1'`])
  })

  it('skips what the pod already put in the registry — a prime never bounces back', async () => {
    // The ledger the prime side writes: its own pulls, plus this pod's
    // earlier pushes. Only the untouched ancestor is left to push. The
    // prime restores the bare name and podman re-adds `localhost/`, so
    // this only lands on the ledger entry because the survey's ref
    // canonicalizes back to the destination the pull recorded — without
    // that the prime/salvage cycle mints the duplicate repo by itself.
    const have = `have ${HEX} ${REG}/myapp:v1\n`
      + `have ${HEX2} ${REG}/myapp:${CACHE_TAG_PREFIX}v1-1\n`
    await expect(salvageReporting(have + CHAIN)).resolves.toBe(true)
    const pairs = pushCommand().match(/'[0-9a-f]{64}' '[^']+'/g) ?? []
    expect(pairs).toEqual([`'${HEX3}' '${REG}/myapp:${CACHE_TAG_PREFIX}v1-2'`])
  })

  it('re-salvages a rebuilt tag — the ledger keys on the id, not the name', async () => {
    // Same destination, new image id: the exact case a dest-only ledger
    // would skip forever, losing every rebuild after the first.
    const have = `have ${HEX} ${REG}/myapp:v1\n`
    const rebuilt = `img sha256:${HEX3}||localhost/myapp:v1,\n`
    await expect(salvageReporting(have + rebuilt)).resolves.toBe(true)
    expect(pushCommand()).toContain(`'${HEX3}' '${REG}/myapp:v1'`)
  })

  it('retires stale slots even when there is nothing left to push', async () => {
    // A crash between the push and retire legs would otherwise strand the
    // tail forever: every later salvage finds the ledger complete and would
    // no-op before reaching retire.
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
    // The registry refuses DELETE for the whole of a blob collect's
    // read-only window, and a salvage runs detached in the pass that
    // starts one.
    mockContainerExec.mockImplementation((_job: string, cmd: string) =>
      Promise.resolve(cmd.includes('image inspect')
        ? { stdout: have + CHAIN, stderr: '' }
        : { stdout: 'retired 0 failed 2\n', stderr: '' }))
    await salvageSessionImages(PARAMS)
    mockContainerExec.mockClear()
    await salvageSessionImages(PARAMS)
    // Second cycle tries again instead of treating the shape as retired.
    expect(mockContainerExec).toHaveBeenCalledTimes(2)
  })

  it('stops re-retiring once the chain shape is unchanged', async () => {
    const have = `have ${HEX} ${REG}/myapp:v1\n`
      + `have ${HEX2} ${REG}/myapp:${CACHE_TAG_PREFIX}v1-1\n`
      + `have ${HEX3} ${REG}/myapp:${CACHE_TAG_PREFIX}v1-2\n`
    await salvageReporting(have + CHAIN)
    mockContainerExec.mockClear()
    // Second cycle, same shape: back to the one-exec no-op the 10-minute
    // reconciler depends on.
    await salvageReporting(have + CHAIN)
    expect(mockContainerExec).toHaveBeenCalledOnce()
  })

  it('retires chain slots a shorter rebuild no longer fills', async () => {
    await expect(salvageReporting(CHAIN)).resolves.toBe(true)
    // Third leg, after the push: repo/tag/depth argv, deleting upward from
    // depth+1 until a slot is already empty.
    const retire = commands()[2].replace(/'\\''/g, "'")
    expect(retire).toContain(`'myapp' 'v1' '2'`)
    expect(retire).toContain('-X DELETE "http://$REG/v2/$repo/manifests/$dg"')
    expect(retire).toContain('[ -n "$dg" ] || break')
    // Failures are counted, not swallowed — see the memo test below.
    expect(retire).toContain('echo "retired $n failed $f"')
  })

  it('drops malformed rows and refs that are already registry copies', async () => {
    await expect(salvageReporting(
      'img not-an-id|| localhost/bad:v1,\n'
      + `img sha256:${HEX}||$(rm~-rf~/):v1,${REG}/localhost/pulled:v1,\n`,
    )).resolves.toBe(true)
    // Nothing survived: the bad id is dropped whole, the shell-metachar ref
    // fails the ref shape, and the registry-hosted ref is already there.
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

describe('primeSessionImages', () => {
  it('pulls the project catalog back, restoring names and leaving cache tags dangling', async () => {
    mockContainerExec.mockResolvedValue({ stdout: 'primed 3\n', stderr: '' })
    await expect(primeSessionImages(PARAMS)).resolves.toBe(true)
    const cmd = commands()[0]
    expect(cmd).toContain(`REG=${REG}`)
    expect(cmd).toContain('/v2/_catalog?n=1000')
    expect(cmd).toContain('/v2/$repo/tags/list')
    expect(cmd).toContain('podman pull --tls-verify=false "$ref"')
    // The prime runs in the background while the agent works, so it takes
    // the lowest scheduling priority (children inherit it).
    expect(cmd).toContain('renice -n 19 $$')
    // A named tag gets its original name back; a chain tag keeps none, so
    // it stays a dangling cache entry exactly like a local --layers build.
    expect(cmd).toContain(`case "$tag" in ${CACHE_TAG_PREFIX}*) ;; *) podman tag "$ref" "$repo:$tag"`)
    // Explicit name: `podman untag <image>` alone removes EVERY name,
    // including the one just restored.
    expect(cmd).toContain('podman untag "$ref" "$ref"')
    // Pulled refs join the ledger WITH their id, so this session's salvage
    // skips them without also skipping a later rebuild of the same name.
    expect(cmd).toContain('echo "$id $ref" >> /var/lib/containers/.yaac-pushed-refs')
    // Per-image budget: one oversized image must not blow past the cap.
    expect(cmd).toContain('"size":[0-9]*')
    expect(cmd).toContain('skipped-large')
    await expect(execFileAsync('sh', ['-n', '-c', cmd])).resolves.toBeTruthy()
  })

  it('stops before filling the session graphroot', async () => {
    mockContainerExec.mockResolvedValue({ stdout: 'primed-full\nprimed 2\n', stderr: '' })
    await expect(primeSessionImages(PARAMS)).resolves.toBe(true)
    const cmd = commands()[0]
    // Pulled layers land in the 8GiB sentry tmpfs, so a project registry
    // holding more than the session can carry degrades to a partial warm-up.
    expect(cmd).toContain('df -P /var/lib/containers')
    expect(cmd).toContain('-lt 50 ] || { echo "primed-full"; break 2; }')
  })

  it('swallows failures — a cold cache only costs a rebuild', async () => {
    mockContainerExec.mockRejectedValue(new Error('engine not up'))
    await expect(primeSessionImages(PARAMS)).resolves.toBe(false)
  })
})
