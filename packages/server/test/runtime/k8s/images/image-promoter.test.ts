/**
 * The push half of the nested-session image cache, exercised through its
 * one barrel entry: `salvageWorktreeImages`.
 *
 * The survey script, its sudo wrapper, the report parser, the push planner
 * and the retire script are all things the salvage hands to a session pod
 * on the way through one teardown. Driving the barrel entry rather than
 * each generator means the pieces are checked as they are actually wired —
 * a parser that silently stops feeding the planner, or a script that stops
 * being reachable, fails here instead of staying green in isolation.
 *
 * The registry-ranking fragment this module also exports is covered where
 * its consumer runs it, in store-writer.test.ts.
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

import { salvageWorktreeImages } from '#runtime/k8s/images'
// The registry the cache rides is the project's own — resolved for real
// here (not stubbed), so a change to its host shape shows up as a broken
// push destination rather than a passing test against a stale constant.
import { projectRegistryHost } from '#runtime/k8s/cluster'
import {
  CACHE_TAG_PREFIX,
  _resetSalvageMemoForTests,
} from '#runtime/k8s/images/image-promoter'

const execFileAsync = promisify(execFile)
const SID = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
const HEX = 'a'.repeat(64)
const HEX2 = 'b'.repeat(64)
const HEX3 = 'c'.repeat(64)

const PARAMS = { jobName: 'yaac-demo-job', projectSlug: 'demo', worktreeId: SID }
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
  return salvageWorktreeImages(PARAMS)
}

/**
 * Three content-hash generations of one repo, named so LEXICAL order is the
 * REVERSE of build order — a ranking that sorted tags instead of reading
 * their build times would pick the opposite two and fail.
 */
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

describe('salvageWorktreeImages', () => {
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

  it('never pushes back what the node image store already provided', async () => {
    // The engine's view inside a warm worktree: the store's base chain
    // read-only, one image the worktree rebuilt on top of it (so its id
    // has a writable row too), and a fresh unnamed layer between them.
    await expect(salvageReporting(
      `ro sha256:${HEX2}\n`
      + `ro sha256:${HEX3}\n`
      + CHAIN,
    )).resolves.toBe(true)
    const push = pushCommand()
    // The leaf is the worktree's own work and travels under its name.
    expect(push).toContain(`'${HEX}' '${REG}/myapp:v1'`)
    // Its ancestors came out of the store, which is nothing but a
    // materialization of THIS registry — re-pushing them would recompress
    // the project's whole working set inside the sandbox for bytes that
    // are already there, so the chain walk stops at the first one.
    expect(push).not.toContain(HEX2)
    expect(push).not.toContain(CACHE_TAG_PREFIX)
    // And no retire runs for that name. The retire leg's whole licence is
    // "the chain was pushed as a contiguous 1..depth, so depth+1 is
    // unreachable" — false the moment the walk stops early, when the chain
    // continues in the registry ABOVE the stop. Retiring there would delete
    // the shared, rarely-changing prefix that a cold node's cache is mostly
    // made of, permanently: salvage skips read-only images, so nothing
    // would ever push them back.
    expect(commands()).toHaveLength(2)
  })

  it('reports which images exist only in the read-only store', async () => {
    await expect(salvageReporting('')).resolves.toBe(true)
    const cmd = surveyCommand()
    // One row per NAME, so an id the worktree ALSO holds writably (it
    // rebuilt or re-tagged a store image) must not be counted read-only —
    // that name is new and does travel.
    expect(cmd).toContain('{{.ID}} {{.ReadOnly}}')
    expect(cmd).toContain('if ($2 == "false") w[$1] = 1')
    expect(cmd).toContain('if (!(i in w)) print "ro " i')
    await expect(execFileAsync('sh', ['-n', '-c', cmd])).resolves.toBeTruthy()
  })

  it('pushes named images under their own name, ancestors as bounded cache tags', async () => {
    await expect(salvageReporting(CHAIN)).resolves.toBe(true)
    const push = pushCommand()
    // gzip, and a nice'd push. The FORMAT is load-bearing: zstd has no
    // docker-schema2 layer media type, so a zstd push silently rewrites a
    // schema2 image as OCI — and buildah only matches a cache candidate
    // whose manifest type equals the format the build emits, which for the
    // session's Docker CLI against podman's compat API is schema2. gzip
    // exists in both schemas and leaves either in place. Level 1 because
    // the compression runs inside the session sandbox, where total CPU is
    // the budget and background work must lose to the agent.
    expect(push).toContain('nice -n 19 podman push --tls-verify=false '
      + '--compression-format gzip --compression-level 1 "$1" "$2"')
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
    // LAYER blobs, since the salvage compresses at level 1 where the host
    // wrote gzip's default level.
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
    await salvageWorktreeImages(PARAMS)
    mockContainerExec.mockClear()
    await salvageWorktreeImages(PARAMS)
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
    await expect(salvageWorktreeImages(PARAMS)).resolves.toBe(false)
  })

  it('coalesces concurrent salvages for the same session', async () => {
    let resolveExec: (v: { stdout: string; stderr: string }) => void = () => {}
    mockContainerExec.mockReturnValue(new Promise((r) => { resolveExec = r }))
    const a = salvageWorktreeImages(PARAMS)
    const b = salvageWorktreeImages(PARAMS)
    resolveExec({ stdout: '', stderr: '' })
    await expect(Promise.all([a, b])).resolves.toEqual([true, true])
    expect(mockContainerExec).toHaveBeenCalledOnce()
  })
})
