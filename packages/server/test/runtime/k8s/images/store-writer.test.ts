/**
 * The node-local image store, exercised through its four barrel entries.
 *
 * Two things have to hold, and they are checked at the two ends the store
 * has. The POD is what the server hands the cluster — a node-pinned,
 * hostNetwork'd, deliberately un-privileged runc pod with the generation
 * parent mounted rw — and the SCRIPT is what actually decides a
 * generation's contents. So the script is not string-matched: it is run,
 * for real, against a stub project registry laid out as the files its
 * `curl` would fetch and a stub `podman` that records what it was asked to
 * pull. What that run proves is the ranking (which of a repo's generations
 * are worth a node's disk), the publish order (nothing is mountable until
 * the DONE marker), and the generation GC.
 *
 * The mount side is driven off a real data dir, because the whole contract
 * of {@link nodeImageStoreMount} is "what does the server see on disk" —
 * a complete generation, an interrupted one, and none at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'

const execFileAsync = promisify(execFile)

vi.mock('#runtime/k8s/substrate/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('#runtime/k8s/container/registry', () => ({
  registryHasTag: vi.fn().mockResolvedValue(true),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
  pushImageToRegistry: vi.fn((tag: string) => Promise.resolve(`localhost:5001/${tag}`)),
}))

vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))

import {
  ensureNodeImageStore,
  nodeImageStoreMount,
  reconcileNodeImageStores,
  removeNodeImageStore,
} from '#runtime/k8s/images'
// Setup values and the reset hook — not a second surface under test.
import {
  DONE_MARKER,
  SHARED_IMAGES_MOUNT,
  STORE_REFRESH_INTERVAL_MS,
  STORE_REFRESH_RETRY_MS,
  STORE_POD_PATH,
  _resetImageStoreForTests,
  generationName,
} from '#runtime/k8s/images/store-writer'
import { CACHED_GENERATIONS_KEPT, CACHE_TAG_PREFIX } from '#runtime/k8s/images/image-promoter'
import { imageStoreDir } from '@yaac/shared/project-paths'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#runtime/k8s/substrate/kubectl'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)

const SLUG = 'demo'
const NODE = 'yaac-control-plane'
const CLUSTER_IP = '10.96.0.50'

let tmpDataDir: string

beforeEach(async () => {
  mockApply.mockReset()
  mockApply.mockResolvedValue(undefined)
  mockRetry.mockReset()
  mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
  mockGetJson.mockReset()
  _resetImageStoreForTests()
  tmpDataDir = await createTempDataDir()
})

afterEach(async () => {
  await cleanupTempDir(tmpDataDir)
})

/**
 * A cluster where the project's registry has its ClusterIP, one node
 * answers, no worktree pod is holding a generation, and every pod run
 * succeeds.
 */
function stageLiveCluster(opts: { podVolumes?: unknown[] } = {}): void {
  mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
    if (args[1] === 'service') return Promise.resolve({ spec: { clusterIP: CLUSTER_IP } })
    if (args[1] === 'nodes') return Promise.resolve({ items: [{ metadata: { name: NODE } }] })
    if (args[1] === 'pods' && args.includes('-l')) {
      return Promise.resolve({ items: [{ spec: { volumes: opts.podVolumes ?? [] } }] })
    }
    // runPodToCompletion's phase poll.
    return Promise.resolve({ status: { phase: 'Succeeded' } })
  })
}

/** Just the parts of a pod manifest these assertions read. */
interface PodManifest {
  kind: string
  metadata: { labels: Record<string, string> }
  spec: {
    nodeName?: string
    hostNetwork?: boolean
    runtimeClassName?: string
    tolerations?: unknown[]
    volumes: Array<{ name: string; hostPath?: { path: string; type: string } }>
    containers: Array<{
      command: string[]
      securityContext?: unknown
      volumeMounts: Array<{ name: string; mountPath: string }>
    }>
  }
}

/** The pod manifests handed to the cluster, in order. */
const appliedPods = (): PodManifest[] =>
  mockApply.mock.calls.map((c) => c[0] as unknown as PodManifest)

/** The `sh -c` script of the first applied pod, and its argv. */
function podCommand(i = 0): { script: string; argv: string[] } {
  const cmd = appliedPods()[i].spec.containers[0].command
  return { script: cmd[2], argv: cmd.slice(4) }
}

const GENERATIONS = { old: 'f'.repeat(16), mid: 'a'.repeat(16), new: '0123456789abcdef' }

/** tag -> the image config's `created`, or null for a tag with no
 *  generation to it (a chain slot, a hand-written name). */
type RepoFixture = Record<string, string | null>

/**
 * A stub project registry the real build script can be pointed at, laid
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
  // The push-prefixed form of a yaac repo. Salvage no longer mints these,
  // but a registry written before that still carries them until the GC
  // sweeps the legacy subtree — and until then they are generations like
  // any other.
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

interface ScriptRun {
  /** Every ref the engine was asked to pull, in order. */
  pulled: string[]
  /** Paths the opaque rewrite whited out, as it reported them. */
  whiteouts: string[]
  /** Generation directories left in the store root afterwards. */
  generations: string[]
  /** Whether the new generation ended up publishable. */
  published: boolean
  stdout: string
}

/**
 * Run the REAL build script against CATALOG in a scratch store root, with
 * `podman` stubbed at the process boundary: a `pull` records its ref and
 * materializes just enough of a containers/storage layout (an `overlay`
 * tree and a `layers.json` carrying diff sizes) for the post-passes to run
 * for real. Everything else in the script — the hardlink seed, the ranking,
 * the opaque rewrite, the metadata assertion, the publish, the GC — is the
 * shipped code.
 */
async function runStoreWriterScript(
  script: string,
  storeRoot: string,
  keep: string[],
  opts: { layers?: unknown[]; overlay?: boolean; breakLowerChain?: boolean } = {},
): Promise<ScriptRun> {
  const dir = await fs.mkdtemp(path.join(tmpDataDir, 'script-'))
  const fx = path.join(dir, 'fx')
  const bin = path.join(dir, 'bin')
  const pullLog = path.join(dir, 'pulls')
  await fs.mkdir(fx)
  await fs.mkdir(bin)
  // The registry's own URL space, flattened to one file per path.
  const put = (url: string, body: string) =>
    fs.writeFile(path.join(fx, url.replace(/\?.*$/, '').replace(/\//g, '_')), body)
  await put('v2/_catalog', JSON.stringify({ repositories: Object.keys(CATALOG) }))
  let n = 0
  for (const [repo, tags] of Object.entries(CATALOG)) {
    await put(`v2/${repo}/tags/list`, JSON.stringify({ name: repo, tags: Object.keys(tags) }))
    for (const [tag, created] of Object.entries(tags)) {
      const cfg = `sha256:${String(++n).padStart(64, '0')}`
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
  await stub('curl', [
    'for a in "$@"; do case "$a" in http://*) url="$a";; esac; done',
    `p=$(printf '%s' "\${url#http://*/}" | sed 's/?.*//' | tr '/' '_')`,
    `[ -f "${fx}/$p" ] || exit 22`,
    `cat "${fx}/$p"`,
  ].join('\n'))
  const layersJson = JSON.stringify(opts.layers ?? [{ id: 'l1', 'diff-size': 4096 }])

  // A REAL two-layer overlay layout for the opaque pass to work on: a lower
  // holding `app/{gone.txt,src/old.js}`, and an upper that REPLACES `app`
  // (the opaque xattr) with `app/src/new.js`. The shared `src` is the whole
  // point — a first-level-only rewrite leaves `old.js` merged in.
  const fixture = path.join(dir, 'fixture.py')
  await fs.writeFile(fixture, [
    'import os, sys',
    "ovl = os.path.join(sys.argv[1], 'overlay')",
    "low = os.path.join(ovl, 'LOW', 'diff')",
    "up = os.path.join(ovl, 'UP', 'diff')",
    "os.makedirs(os.path.join(low, 'app', 'src'), exist_ok=True)",
    "os.makedirs(os.path.join(up, 'app', 'src'), exist_ok=True)",
    "open(os.path.join(low, 'app', 'src', 'old.js'), 'w').close()",
    "open(os.path.join(low, 'app', 'gone.txt'), 'w').close()",
    "open(os.path.join(low, 'untouched.txt'), 'w').close()",
    "open(os.path.join(up, 'app', 'src', 'new.js'), 'w').close()",
    "os.makedirs(os.path.join(ovl, 'l'), exist_ok=True)",
    "link = os.path.join(ovl, 'l', 'LOWLINK')",
    "os.path.islink(link) or os.symlink('../LOW/diff', link)",
    `open(os.path.join(ovl, 'UP', 'lower'), 'w').write('${opts.breakLowerChain ? 'l/MISSING' : 'l/LOWLINK'}')`,
    // The store builder runs unprivileged, so this is the namespace
    // containers/storage itself picks there (see the module doc).
    "os.setxattr(os.path.join(up, 'app'), 'user.overlay.opaque', b'y')",
  ].join('\n'))

  await stub('podman', [
    // The graphroot comes from the storage.conf the script wrote.
    `g=$(sed -n 's/^graphroot = "\\(.*\\)"$/\\1/p' "\${CONTAINERS_STORAGE_CONF:-/dev/null}")`,
    'case "$1" in',
    `  pull) shift; for a in "$@"; do case "$a" in -*) ;; *) echo "$a" >> "${pullLog}";; esac; done`,
    '    mkdir -p "$g/overlay/l" "$g/overlay-layers"',
    `    printf '%s' '${layersJson}' > "$g/overlay-layers/layers.json"`,
    ...(opts.overlay ? [`    python3 ${fixture} "$g"`] : []),
    '    ;;',
    'esac',
    'exit 0',
  ].join('\n'))

  // The one thing this environment genuinely cannot do: `mknod` of a
  // character device needs CAP_MKNOD, which the test user does not have.
  // Stubbing it at the interpreter boundary keeps the shipped pass running
  // for real — it still decides WHICH whiteouts to make, which is the part
  // that has been wrong before — and its own report is what is asserted.
  const realPython = (await execFileAsync('sh', ['-c', 'command -v python3'])).stdout.trim()
  await stub('python3', [
    'if [ "$1" = "-" ]; then',
    '  shift',
    `  exec ${realPython} -c '`,
    'import os, sys',
    'os.mknod = lambda p, mode=0, device=0: open(p, "wb").close()',
    'src = sys.stdin.read()',
    'sys.argv = ["-"] + sys.argv[1:]',
    'exec(compile(src, "<store-script>", "exec"))',
    `' "$@"`,
    'fi',
    `exec ${realPython} "$@"`,
  ].join('\n'))
  try {
    const { stdout } = await execFileAsync('sh', ['-c', script, '--', storeRoot, ...keep], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    const generations = (await fs.readdir(storeRoot)).filter((e) => e.startsWith('gen-')).sort()
    const newest = generations[generations.length - 1]
    return {
      pulled: await fs.readFile(pullLog, 'utf8').then((s) => s.split('\n').filter(Boolean), () => []),
      whiteouts: stdout.split('\n')
        .filter((l) => l.startsWith('store-opaque-whiteout '))
        .map((l) => l.slice('store-opaque-whiteout '.length).trim())
        .sort(),
      generations,
      published: newest !== undefined
        && await fs.access(path.join(storeRoot, newest, DONE_MARKER)).then(() => true, () => false),
      stdout,
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('ensureNodeImageStore', () => {
  it('runs an unprivileged node-pinned builder that writes the store on the host network', async () => {
    stageLiveCluster()
    await expect(ensureNodeImageStore(SLUG)).resolves.toBe(true)

    const [pod] = appliedPods()
    expect(pod.kind).toBe('Pod')
    expect(pod.spec.nodeName).toBe(NODE)
    // In the host netns the pod IS the node, which is what the project
    // registry's ingress already admits — so there is no NetworkPolicy to
    // add on either side, and the registry has to be named by ClusterIP
    // because the node is not a cluster-DNS client.
    expect(pod.spec.hostNetwork).toBe(true)
    expect(podCommand().script).toContain(`REG=${CLUSTER_IP}:5000`)
    // Trusted infra: runc (no RuntimeClass), and tolerating everything
    // because `nodeName` bypasses the scheduler but not kubelet admission.
    expect(pod.spec.runtimeClassName).toBeUndefined()
    expect(pod.spec.tolerations).toEqual([{ operator: 'Exists' }])
    // Deliberately un-privileged: a pull needs no CAP_SYS_ADMIN, and
    // withholding it is what makes containers/storage record opaque dirs
    // in the `user.` xattr namespace the rewrite pass can read back.
    const ctr = pod.spec.containers[0]
    expect(ctr.securityContext).toEqual({ runAsUser: 0 })
    expect(JSON.stringify(pod)).not.toContain('SYS_ADMIN')
    expect(JSON.stringify(pod)).not.toContain('privileged')
    // The generation parent, rw, at the path the script is handed as argv.
    expect(pod.spec.volumes).toEqual([{
      name: 'store',
      hostPath: { path: imageStoreDir(SLUG), type: 'DirectoryOrCreate' },
    }])
    expect(ctr.volumeMounts).toEqual([{ name: 'store', mountPath: STORE_POD_PATH }])
    expect(podCommand().argv[0]).toBe(STORE_POD_PATH)
    await expect(execFileAsync('sh', ['-n', '-c', podCommand().script])).resolves.toBeTruthy()
  })

  it('pulls the newest generations of yaac-built repos and nothing a dead one supports', async () => {
    stageLiveCluster()
    await ensureNodeImageStore(SLUG)
    const storeRoot = await fs.mkdtemp(path.join(tmpDataDir, 'store-'))
    const { pulled, published } = await runStoreWriterScript(podCommand().script, storeRoot, [])

    const gen = (repo: string, which: keyof typeof GENERATIONS) =>
      `${CLUSTER_IP}:5000/${repo}:${GENERATIONS[which]}`
    // Newest two of each yaac repo, and their chain slots with them.
    expect(pulled).toContain(gen('yaac-tools', 'new'))
    expect(pulled).toContain(gen('yaac-tools', 'mid'))
    expect(pulled).toContain(`${CLUSTER_IP}:5000/yaac-tools:${CACHE_TAG_PREFIX}${GENERATIONS.new}-1`)
    // Same for the push-prefixed form of a yaac repo, which the guard has
    // to recognize or a real registry's copies go unranked.
    expect(pulled).toContain(gen('localhost/yaac-base', 'new'))
    expect(pulled).toContain(gen('localhost/yaac-base', 'mid'))
    // The retired generation is not pulled, and neither are the
    // intermediates that only ever cache-hit against it.
    expect(pulled).not.toContain(gen('yaac-tools', 'old'))
    expect(pulled).not.toContain(gen('localhost/yaac-base', 'old'))
    expect(pulled.some((r) => r.includes(`${CACHE_TAG_PREFIX}${GENERATIONS.old}`))).toBe(false)
    // yaac-flaky's newest generation has no readable config. It is kept
    // anyway and the OLDEST readable one gives up the slot: one transient
    // fetch failure must not cost the node the generation its next build
    // would have cache-hit.
    expect(pulled).toContain(gen('yaac-flaky', 'new'))
    expect(pulled).toContain(gen('yaac-flaky', 'mid'))
    expect(pulled).not.toContain(gen('yaac-flaky', 'old'))
    // A hand-written tag is not a generation: the upstream mirror comes
    // back whole, chain slots included. Nor is a content-hash-SHAPED tag on
    // a repo that is not yaac's chain — ranking mirrors the registry
    // retention pass on both halves of its guard.
    expect(pulled).toContain(`${CLUSTER_IP}:5000/podman-stable:v5`)
    expect(pulled).toContain(`${CLUSTER_IP}:5000/myapp:v1`)
    expect(pulled).toContain(`${CLUSTER_IP}:5000/myapp:${CACHE_TAG_PREFIX}v1-1`)
    expect(pulled).toContain(gen('myapp', 'old'))
    // Named before chain, so the image a worktree refers to is warmed
    // before the intermediates that only accelerate a rebuild.
    expect(pulled.indexOf(gen('yaac-tools', 'new')))
      .toBeLessThan(pulled.indexOf(`${CLUSTER_IP}:5000/yaac-tools:${CACHE_TAG_PREFIX}${GENERATIONS.new}-1`))
    expect(published).toBe(true)

    // yaac-tied's three generations carry the same timestamp, so there is
    // nothing to rank by. Which two survive is arbitrary; that it is always
    // the same two, and always two, is not — an unstable tie-break would
    // churn a node's store on every build for no gain.
    const tied = (rs: string[]) => rs.filter((r) => r.startsWith(`${CLUSTER_IP}:5000/yaac-tied:`))
    expect(tied(pulled)).toHaveLength(CACHED_GENERATIONS_KEPT)
    const again = await runStoreWriterScript(
      podCommand().script, await fs.mkdtemp(path.join(tmpDataDir, 'store-')), [])
    expect(tied(again.pulled)).toEqual(tied(pulled))
  })

  it('whites out a replaced directory ALL THE WAY DOWN, not just its first level', async () => {
    stageLiveCluster()
    await ensureNodeImageStore(SLUG)
    const storeRoot = await fs.mkdtemp(path.join(tmpDataDir, 'store-'))
    const { whiteouts, published } = await runStoreWriterScript(
      podCommand().script, storeRoot, [], { overlay: true })

    // Opacity hides the lower directory AND everything under it. The
    // shared `src` is the trap: whiting out only the top level leaves it a
    // live merge point, so `old.js` reappears inside a directory the image
    // replaced wholesale — an image that is silently wrong while its id,
    // its digests and `image ls` all look perfect.
    expect(whiteouts).toEqual(['app/gone.txt', 'app/src/old.js'])
    // ...and nothing outside the replaced directory is touched.
    expect(whiteouts).not.toContain('untouched.txt')
    expect(published).toBe(true)
  })

  it('publishes nothing when the lower chain it must read is broken', async () => {
    stageLiveCluster()
    await ensureNodeImageStore(SLUG)
    const storeRoot = await fs.mkdtemp(path.join(tmpDataDir, 'store-'))
    // A `lower` file naming a link that does not resolve. Fail-open here
    // would shrink the whiteout set and then hardlink that hole into every
    // later generation via the per-layer marker, so the build has to die
    // instead and leave the last good generation mounted.
    await expect(runStoreWriterScript(podCommand().script, storeRoot, [], {
      overlay: true,
      breakLowerChain: true,
    })).rejects.toThrow(/cannot resolve lower/)
    for (const g of await fs.readdir(storeRoot)) {
      await expect(fs.access(path.join(storeRoot, g, DONE_MARKER))).rejects.toThrow()
    }
  })

  it('drops the generations nothing can be holding, and keeps the one a create may just have read', async () => {
    const storeRoot = await fs.mkdtemp(path.join(tmpDataDir, 'store-'))
    // Three predecessors: an old complete one nothing references, the
    // NEWEST complete one (what a create would have pinned), and one a
    // crashed build left without a DONE marker.
    const [superseded, newest, partial] = [generationName(1), generationName(2), generationName(3)]
    for (const g of [superseded, newest, partial]) await fs.mkdir(path.join(storeRoot, g))
    for (const g of [superseded, newest]) {
      await fs.writeFile(path.join(storeRoot, g, DONE_MARKER), 'x')
    }

    stageLiveCluster()
    await ensureNodeImageStore(SLUG)
    // Deliberately an EMPTY keep list: no pod had been created when the
    // server computed it. The newest complete generation must survive
    // anyway — a create reads it and fires this build, so a pod can appear
    // between the two, and dropping it would empty a running engine's
    // store. One build cycle later that pod is in the live set.
    const { generations, published, stdout } = await runStoreWriterScript(
      podCommand().script, storeRoot, [])
    expect(published).toBe(true)
    expect(generations).toContain(newest)
    expect(generations).not.toContain(superseded)
    expect(generations).not.toContain(partial)
    expect(stdout).toContain('store-generations kept 2 dropped 2')

    // A layer without a recorded diff size would make `podman images`
    // decompress its tar-split — ruinous over the gofer — so the build
    // fails before the marker, leaving the last good generation mounted.
    _resetImageStoreForTests()
    mockApply.mockClear()
    await ensureNodeImageStore(SLUG)
    const storeRoot2 = await fs.mkdtemp(path.join(tmpDataDir, 'store2-'))
    await expect(runStoreWriterScript(podCommand().script, storeRoot2, [], {
      layers: [{ id: 'l1', 'diff-size': 4096 }, { id: 'l2' }],
    })).rejects.toThrow(/missing recorded diff sizes/)
    const left = await fs.readdir(storeRoot2)
    for (const g of left) {
      await expect(fs.access(path.join(storeRoot2, g, DONE_MARKER))).rejects.toThrow()
    }
  })

  it('throttles repeat builds, and lets a salvage that pushed jump the queue', async () => {
    stageLiveCluster()
    const t0 = 1_000_000
    await expect(ensureNodeImageStore(SLUG, { nowMs: t0 })).resolves.toBe(true)
    await expect(ensureNodeImageStore(SLUG, { nowMs: t0 + 1000 })).resolves.toBe(false)
    // A push into the registry is the one moment there is new content, so
    // it is worth a build regardless of when the last one ran.
    await expect(ensureNodeImageStore(SLUG, { nowMs: t0 + 1000, force: true })).resolves.toBe(true)
    // The forced build reset the clock like any other, so the next
    // unforced one waits a full interval from IT.
    await expect(
      ensureNodeImageStore(SLUG, { nowMs: t0 + 1000 + STORE_REFRESH_INTERVAL_MS - 1 }),
    ).resolves.toBe(false)
    await expect(
      ensureNodeImageStore(SLUG, { nowMs: t0 + 1000 + STORE_REFRESH_INTERVAL_MS }),
    ).resolves.toBe(true)
  })

  // The stray sweep runs before every build, so a run whose server died
  // mid-poll cannot leave a pod behind that a later namesake never collects.
  it('sweeps strays from a crashed run before building', async () => {
    stageLiveCluster()
    await ensureNodeImageStore(SLUG)
    const deletes = mockRetry.mock.calls.map((c) => c[0].join(' '))
    expect(deletes.some((d) =>
      d.includes('delete pod') && d.includes('app=yaac-image-store')
      && d.includes(`yaac.project=${SLUG}`),
    )).toBe(true)
  })

  it('is a no-op when the project has no registry to build from', async () => {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      if (args[1] === 'service') return Promise.resolve(null)
      return Promise.resolve({ items: [] })
    })
    await expect(ensureNodeImageStore(SLUG)).resolves.toBe(false)
    expect(appliedPods()).toHaveLength(0)
  })

  it('retries a failed build on the short backoff, not the full interval', async () => {
    // A build that publishes nothing is nearly always transient — the
    // commonest cause is racing the registry's own maintenance rollout, a
    // few seconds — so it must not leave the project a generation behind
    // for the whole interval.
    mockGetJson.mockImplementation(() => Promise.resolve(null))
    const t0 = 1_000_000
    await expect(ensureNodeImageStore(SLUG, { nowMs: t0 })).resolves.toBe(false)
    stageLiveCluster()
    await expect(
      ensureNodeImageStore(SLUG, { nowMs: t0 + STORE_REFRESH_RETRY_MS - 1 }),
    ).resolves.toBe(false)
    await expect(
      ensureNodeImageStore(SLUG, { nowMs: t0 + STORE_REFRESH_RETRY_MS }),
    ).resolves.toBe(true)
  })
})

describe('nodeImageStoreMount', () => {
  it('pins the newest COMPLETE generation, read-only', async () => {
    const parent = imageStoreDir(SLUG)
    const [older, newer, partial] = [generationName(1), generationName(2), generationName(3)]
    for (const g of [older, newer, partial]) await fs.mkdir(path.join(parent, g), { recursive: true })
    for (const g of [older, newer]) await fs.writeFile(path.join(parent, g, DONE_MARKER), 'x')

    // `partial` sorts newest but has no marker: a build that crashed
    // mid-pull must never become a worktree's store.
    await expect(nodeImageStoreMount(SLUG)).resolves.toEqual({
      source: { kind: 'hostPath', path: path.join(parent, newer) },
      mountPath: SHARED_IMAGES_MOUNT,
      readOnly: true,
    })
  })

  it('mounts nothing on a cold node', async () => {
    await expect(nodeImageStoreMount(SLUG)).resolves.toBeUndefined()
    await fs.mkdir(path.join(imageStoreDir(SLUG), generationName(1)), { recursive: true })
    await expect(nodeImageStoreMount(SLUG)).resolves.toBeUndefined()
  })
})

describe('reconcileNodeImageStores', () => {
  it('fires one detached build per project', async () => {
    stageLiveCluster()
    reconcileNodeImageStores([SLUG, 'other'])
    // Detached: the sweep returns before any pod has been applied.
    expect(appliedPods()).toHaveLength(0)
    await vi.waitFor(() => expect(appliedPods()).toHaveLength(2))
    const slugs = appliedPods().map((p) => p.metadata.labels['yaac.project'])
    expect(new Set(slugs)).toEqual(new Set([SLUG, 'other']))
  })
})

describe('removeNodeImageStore', () => {
  it('removes the project directory from every node with a one-shot pod', async () => {
    stageLiveCluster()
    await removeNodeImageStore(SLUG)
    const [pod] = appliedPods()
    expect(pod.spec.nodeName).toBe(NODE)
    // The PARENT is mounted, so the project's own directory can go — the
    // server's uid cannot remove these root-owned bytes itself.
    expect(pod.spec.volumes[0].hostPath?.path).toBe(path.dirname(imageStoreDir(SLUG)))
    expect(pod.spec.containers[0].command[2])
      .toContain(`rm -rf /store-parent/${path.basename(imageStoreDir(SLUG))}`)
  })
})
