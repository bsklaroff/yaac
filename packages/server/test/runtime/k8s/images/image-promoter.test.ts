/**
 * The nested-session image cache, exercised through its two barrel entries:
 * `salvageWorktreeImages` (push into the project registry) and
 * `primeWorktreeImages` (pull back into a fresh session's engine).
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
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

import { primeWorktreeImages, salvageWorktreeImages } from '#runtime/k8s/images'
// The registry the cache rides is the project's own — resolved for real
// here (not stubbed), so a change to its host shape shows up as a broken
// push destination rather than a passing test against a stale constant.
import { projectRegistryHost } from '#runtime/k8s/cluster'
import {
  CACHE_TAG_PREFIX,
  PRIME_GENERATIONS_KEPT,
  PRIME_MAX_GRAPHROOT_PERCENT,
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
const GENERATIONS = { old: 'f'.repeat(16), mid: 'a'.repeat(16), new: '0123456789abcdef' }

/** tag -> the image config's `created`, or null for a tag with no
 *  generation to it (a chain slot, a hand-written name). */
type RepoFixture = Record<string, string | null>

/**
 * A stub project registry the real prime script can be pointed at, laid
 * out as the files its `curl` calls would fetch. Repos are listed
 * oldest-generation-first so catalog order cannot be what produces a
 * correct answer either.
 */
const CATALOG: Record<string, RepoFixture> = {
  'yaac-tools': {
    [GENERATIONS.old]: '2026-01-01T00:00:00Z',
    [GENERATIONS.mid]: '2026-02-01T00:00:00Z',
    [GENERATIONS.new]: '2026-03-01T00:00:00Z',
    [`${CACHE_TAG_PREFIX}${GENERATIONS.old}-1`]: null,
    [`${CACHE_TAG_PREFIX}${GENERATIONS.new}-1`]: null,
  },
  // The push-prefixed form of a yaac repo. Salvage no longer mints these
  // (see LOCAL_REGISTRY_PREFIX), but a registry written before that still
  // carries them until the GC sweeps the legacy subtree — and until then
  // they are generations like any other.
  'localhost/yaac-base': {
    [GENERATIONS.old]: '2026-01-02T00:00:00Z',
    [GENERATIONS.mid]: '2026-02-02T00:00:00Z',
    [GENERATIONS.new]: '2026-03-02T00:00:00Z',
  },
  // Newest generation's config will not scrape (no blob written for it).
  'yaac-flaky': {
    [GENERATIONS.old]: '2026-01-03T00:00:00Z',
    [GENERATIONS.mid]: '2026-02-03T00:00:00Z',
    [GENERATIONS.new]: null,
  },
  // Three generations built in the same instant — nothing to rank by.
  'yaac-tied': {
    [GENERATIONS.old]: '2026-04-01T00:00:00Z',
    [GENERATIONS.mid]: '2026-04-01T00:00:00Z',
    [GENERATIONS.new]: '2026-04-01T00:00:00Z',
  },
  'podman-stable': { v5: null },
  // A session's OWN repo that happens to tag by short commit sha — the
  // content-hash shape without being yaac's chain.
  myapp: {
    [GENERATIONS.old]: '2026-05-01T00:00:00Z',
    [GENERATIONS.mid]: '2026-05-02T00:00:00Z',
    [GENERATIONS.new]: '2026-05-03T00:00:00Z',
    v1: null,
    [`${CACHE_TAG_PREFIX}v1-1`]: null,
  },
}

/**
 * Run the real (sudo-wrapped) prime command against CATALOG, and report
 * every ref its engine was asked to pull, in order.
 *
 * The stub `podman pull` FAILS, which the script handles with `|| continue`
 * — so the run exercises the whole catalog walk, the generation ranking and
 * both budgets without ever reaching the ledger append, whose path is
 * absolute and belongs to a real engine no unit test may write.
 */
async function runPrimeScript(cmd: string, catalog: Record<string, RepoFixture>): Promise<string[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-prime-test-'))
  const fx = path.join(dir, 'fx')
  const bin = path.join(dir, 'bin')
  const pullLog = path.join(dir, 'pulls')
  await fs.mkdir(fx)
  await fs.mkdir(bin)
  // The registry's own URL space, flattened to one file per path.
  const put = (url: string, body: string) =>
    fs.writeFile(path.join(fx, url.replace(/\?.*$/, '').replace(/\//g, '_')), body)
  await put('v2/_catalog', JSON.stringify({ repositories: Object.keys(catalog) }))
  let n = 0
  for (const [repo, tags] of Object.entries(catalog)) {
    await put(`v2/${repo}/tags/list`, JSON.stringify({ name: repo, tags: Object.keys(tags) }))
    for (const [tag, created] of Object.entries(tags)) {
      const cfg = `sha256:${String(++n).padStart(64, '0')}`
      // Layer sizes are what the per-image budget reads; keep them small so
      // this test is about the ranking and not about the size gate.
      await put(`v2/${repo}/manifests/${tag}`, JSON.stringify({
        schemaVersion: 2,
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: cfg, size: 512 },
        layers: [{ digest: `sha256:${'e'.repeat(64)}`, size: 1024 }],
      }))
      if (created === null) continue
      // A real config carries `created` twice over — once at top level and
      // once per history entry. The scrape must not depend on which.
      await put(`v2/${repo}/blobs/${cfg}`, JSON.stringify({
        created,
        history: [{ created: '2020-01-01T00:00:00Z' }, { created }],
      }))
    }
  }
  const stub = async (name: string, body: string) => {
    await fs.writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }
  // Passwordless sudo, minus the flags the wrapper passes it.
  await stub('sudo', 'while [ $# -gt 0 ]; do case "$1" in -n|-H) shift;; *) break;; esac; done\nexec "$@"')
  await stub('curl', [
    'for a in "$@"; do case "$a" in http://*) url="$a";; esac; done',
    `p=$(printf '%s' "\${url#http://*/}" | sed 's/?.*//' | tr '/' '_')`,
    `[ -f "${fx}/$p" ] || exit 22`,
    `cat "${fx}/$p"`,
  ].join('\n'))
  await stub('podman', [
    'case "$1" in',
    // Log the ref, then fail: a cold pull is a path the script handles.
    `  pull) shift; for a in "$@"; do case "$a" in -*) ;; *) echo "$a" >> "${pullLog}";; esac; done; exit 1;;`,
    'esac',
    'exit 0',
  ].join('\n'))
  // A graphroot with room to spare, so neither budget is what gates this.
  await stub('df', 'echo "Filesystem 1024-blocks Used Available Capacity Mounted"\n'
    + 'echo "none 10485760 1048576 9437184 10% /var/lib/containers"')
  try {
    await execFileAsync('sh', ['-c', cmd], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    return (await fs.readFile(pullLog, 'utf8')).split('\n').filter(Boolean)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
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

describe('primeWorktreeImages', () => {
  it('pulls the project catalog back, restoring names and leaving cache tags dangling', async () => {
    mockContainerExec.mockResolvedValue({ stdout: 'primed 3\n', stderr: '' })
    await expect(primeWorktreeImages(PARAMS)).resolves.toBe(true)
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
    await expect(primeWorktreeImages(PARAMS)).resolves.toBe(true)
    const cmd = commands()[0]
    // Pulled layers land in the session's sentry tmpfs, so a project
    // registry holding more than the session can carry degrades to a
    // partial warm-up.
    expect(cmd).toContain('df -P /var/lib/containers')
    expect(cmd).toContain(`-lt ${PRIME_MAX_GRAPHROOT_PERCENT} ] || { echo "primed-full"; break 2; }`)
  })

  it('spends the budget on the newest generations, not on whatever the catalog lists first', async () => {
    mockContainerExec.mockResolvedValue({ stdout: 'primed 0\n', stderr: '' })
    await expect(primeWorktreeImages(PARAMS)).resolves.toBe(true)
    // The real script, run against a stub registry and a stub engine whose
    // pull always fails: every ref it ASKS for is one the ranking chose,
    // and a failing pull is a path the script already handles (`|| continue`),
    // so it never reaches the ledger this unit test must not write.
    const pulled = await runPrimeScript(commands()[0], CATALOG)
    const gen = (repo: string, which: keyof typeof GENERATIONS) =>
      `${REG}/${repo}:${GENERATIONS[which]}`
    // Newest two of each yaac repo, and their chain slots with them.
    expect(pulled).toContain(gen('yaac-tools', 'new'))
    expect(pulled).toContain(gen('yaac-tools', 'mid'))
    expect(pulled).toContain(`${REG}/yaac-tools:${CACHE_TAG_PREFIX}${GENERATIONS.new}-1`)
    // Same for the push-prefixed form of a yaac repo, which the guard has
    // to recognize or a real registry's copies go unranked.
    expect(pulled).toContain(gen('localhost/yaac-base', 'new'))
    expect(pulled).toContain(gen('localhost/yaac-base', 'mid'))
    // The retired generation is not pulled, and neither are the
    // intermediates that only ever cache-hit against it.
    expect(pulled).not.toContain(gen('yaac-tools', 'old'))
    expect(pulled).not.toContain(gen('localhost/yaac-base', 'old'))
    expect(pulled.some((r) => r.includes(`${CACHE_TAG_PREFIX}${GENERATIONS.old}`))).toBe(false)
    // A hand-written tag is not a generation: the upstream mirror comes
    // back whole, chain slots included.
    expect(pulled).toContain(`${REG}/podman-stable:v5`)
    expect(pulled).toContain(`${REG}/myapp:v1`)
    expect(pulled).toContain(`${REG}/myapp:${CACHE_TAG_PREFIX}v1-1`)
    // Nor is a content-hash-SHAPED tag on a repo that is not yaac's chain.
    // Ranking mirrors the registry retention pass on both halves of its
    // guard, so a session tagging `myapp` by short commit sha keeps every
    // tag warmed — retention has no say over that repo either.
    expect(pulled).toContain(gen('myapp', 'new'))
    expect(pulled).toContain(gen('myapp', 'mid'))
    expect(pulled).toContain(gen('myapp', 'old'))
    // Named before chain, so the image a session refers to wins the budget
    // over the intermediates that only accelerate a rebuild.
    expect(pulled.indexOf(gen('yaac-tools', 'new')))
      .toBeLessThan(pulled.indexOf(`${REG}/yaac-tools:${CACHE_TAG_PREFIX}${GENERATIONS.new}-1`))
  })

  it('ranks what it cannot read toward inclusion, and breaks a tie the same way twice', async () => {
    mockContainerExec.mockResolvedValue({ stdout: 'primed 0\n', stderr: '' })
    await expect(primeWorktreeImages(PARAMS)).resolves.toBe(true)
    const cmd = commands()[0]
    const pulled = await runPrimeScript(cmd, CATALOG)
    const gen = (repo: string, which: keyof typeof GENERATIONS) =>
      `${REG}/${repo}:${GENERATIONS[which]}`
    // yaac-flaky's newest generation has no readable config. It is kept
    // anyway, and the OLDEST readable one is what gives up the slot: one
    // transient fetch failure must not cost the session the generation its
    // next build would have cache-hit, which is what sorting the
    // unrankable last would do — silently, and to the worst possible one.
    expect(pulled).toContain(gen('yaac-flaky', 'new'))
    expect(pulled).toContain(gen('yaac-flaky', 'mid'))
    expect(pulled).not.toContain(gen('yaac-flaky', 'old'))
    // yaac-tied's three generations carry the same timestamp, so there is
    // nothing to rank by. Which two survive is arbitrary; that it is always
    // the same two, and always two, is not.
    const tied = (rs: string[]) => rs.filter((r) => r.startsWith(`${REG}/yaac-tied:`))
    expect(tied(pulled)).toHaveLength(PRIME_GENERATIONS_KEPT)
    expect(tied(await runPrimeScript(cmd, CATALOG))).toEqual(tied(pulled))
  })

  it('swallows failures — a cold cache only costs a rebuild', async () => {
    mockContainerExec.mockRejectedValue(new Error('engine not up'))
    await expect(primeWorktreeImages(PARAMS)).resolves.toBe(false)
  })
})
