/**
 * The node-local image store, through its four barrel functions.
 *
 * The pod manifest is asserted directly (node-pinned, host network,
 * unprivileged runc, store dir mounted rw). The build script is run for real
 * against a stub registry (files its `curl` fetches) and a stub `podman` that
 * records pulls. That checks generation ranking, publish order (nothing is
 * mountable before the DONE marker) and generation GC.
 *
 * {@link nodeImageStoreMount} reads a real data dir: a complete generation,
 * an interrupted one, and none at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'

const execFileAsync = promisify(execFile)

vi.mock('#drivers/k8s/substrate/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('#drivers/k8s/container/registry', () => ({
  registryHasTag: vi.fn().mockResolvedValue(true),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
  pushImageToRegistry: vi.fn((tag: string) => Promise.resolve(`localhost:5001/${tag}`)),
}))


import {
  ensureNodeImageStore,
  nodeImageStoreMount,
  reconcileNodeImageStores,
} from '#drivers/k8s/images'
// Setup values and state reset, not units under test.
import {
  DONE_MARKER,
  SHARED_IMAGES_MOUNT,
  STORE_REFRESH_INTERVAL_MS,
  STORE_REFRESH_RETRY_MS,
  STORE_POD_PATH,
  _resetImageStoreForTests,
  generationName,
} from '#drivers/k8s/images/store-writer'
import { CACHED_GENERATIONS_KEPT, CACHE_TAG_PREFIX } from '#drivers/k8s/images/image-promoter'
import { imageStoreDir } from '@yaac/shared/project-paths'
import { nodeLocalHostPath, nodeLocalNodePath } from '#drivers/k8s/substrate'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#drivers/k8s/substrate/kubectl'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)

const ID = '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c'
const PROJECT = { slug: 'demo', id: ID }
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
 * answers, no workspace pod is holding a generation, and every pod run
 * succeeds.
 */
function stageLiveCluster(opts: { podVolumes?: unknown[] } = {}): void {
  mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
    if (args[1] === 'service') return Promise.resolve({ spec: { clusterIP: CLUSTER_IP } })
    if (args[1] === 'nodes') return Promise.resolve({ items: [{ metadata: { name: NODE } }] })
    if (args[1] === 'pods' && args.includes('-l')) {
      return Promise.resolve({ items: [{ spec: { volumes: opts.podVolumes ?? [] } }] })
    }
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

/** tag -> the image config's `created`, or null for a tag with no config blob. */
type RepoFixture = Record<string, string | null>

/**
 * A stub project registry for the real build script. Tags are listed
 * oldest first, so listing order cannot produce the right answer by luck.
 */
const CATALOG: Record<string, RepoFixture> = {
  'yaac-tools': {
    [GENERATIONS.old]: '2026-01-01T00:00:00Z',
    [GENERATIONS.mid]: '2026-02-01T00:00:00Z',
    [GENERATIONS.new]: '2026-03-01T00:00:00Z',
    [`${CACHE_TAG_PREFIX}${GENERATIONS.old}-1`]: null,
    [`${CACHE_TAG_PREFIX}${GENERATIONS.new}-1`]: null,
  },
  // The newest generation's config blob is missing.
  'yaac-flaky': {
    [GENERATIONS.old]: '2026-01-03T00:00:00Z',
    [GENERATIONS.mid]: '2026-02-03T00:00:00Z',
    [GENERATIONS.new]: null,
  },
  // Three generations with the same timestamp.
  'yaac-tied': {
    [GENERATIONS.old]: '2026-04-01T00:00:00Z',
    [GENERATIONS.mid]: '2026-04-01T00:00:00Z',
    [GENERATIONS.new]: '2026-04-01T00:00:00Z',
  },
  'podman-stable': { v5: null },
  // A user repo whose tags look like content hashes but are not yaac's.
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
 * Run the real build script against CATALOG in a scratch store root. The
 * `podman` stub records each pull and creates just enough containers/storage
 * layout (an `overlay` tree and `layers.json`) for the later steps to run.
 * Everything else in the script is the shipped code.
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
      // A real config has `created` at top level and in each history entry.
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

  // A two-layer overlay layout: a lower with `app/{gone.txt,src/old.js}`
  // and an upper that replaces `app` (opaque xattr) with `app/src/new.js`.
  // The shared `src` catches a rewrite that only handles the first level.
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
    // Unprivileged containers/storage uses the `user.` xattr namespace.
    "os.setxattr(os.path.join(up, 'app'), 'user.overlay.opaque', b'y')",
  ].join('\n'))

  await stub('podman', [
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

  // `mknod` of a character device needs CAP_MKNOD, which the test user
  // lacks, so it is stubbed inside python. The shipped code still decides
  // which whiteouts to make, and its report is asserted.
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
    await expect(ensureNodeImageStore(PROJECT)).resolves.toBe(true)

    const [pod] = appliedPods()
    expect(pod.kind).toBe('Pod')
    expect(pod.spec.nodeName).toBe(NODE)
    // On the host network the pod counts as the node, which the registry's
    // ingress already admits. The node has no cluster DNS, so the registry
    // is named by ClusterIP.
    expect(pod.spec.hostNetwork).toBe(true)
    expect(podCommand().script).toContain(`REG=${CLUSTER_IP}:5000`)
    // Trusted infra on runc. Tolerates everything, since `nodeName` skips
    // the scheduler but not taint eviction.
    expect(pod.spec.runtimeClassName).toBeUndefined()
    expect(pod.spec.tolerations).toEqual([{ operator: 'Exists' }])
    // Unprivileged: a pull needs no CAP_SYS_ADMIN, and without it
    // containers/storage records opaque dirs in `user.` xattrs, which the
    // rewrite pass reads.
    const ctr = pod.spec.containers[0]
    expect(ctr.securityContext).toEqual({ runAsUser: 0 })
    expect(JSON.stringify(pod)).not.toContain('SYS_ADMIN')
    expect(JSON.stringify(pod)).not.toContain('privileged')
    // The store dir, rw, using the node's path under this install's
    // node-local tree, not the server's.
    expect(pod.spec.volumes).toEqual([{
      name: 'store',
      hostPath: { path: nodeLocalHostPath(imageStoreDir(ID)), type: 'DirectoryOrCreate' },
    }])
    expect(pod.spec.volumes[0].hostPath?.path).toBe(`${nodeLocalNodePath()}/shared-images/${ID}`)
    expect(ctr.volumeMounts).toEqual([{ name: 'store', mountPath: STORE_POD_PATH }])
    expect(podCommand().argv[0]).toBe(STORE_POD_PATH)
    await expect(execFileAsync('sh', ['-n', '-c', podCommand().script])).resolves.toBeTruthy()
  })

  it('writes ONE generation name on every node, so the name the server picks exists everywhere', async () => {
    stageLiveCluster()
    const base = mockGetJson.getMockImplementation()!
    mockGetJson.mockImplementation((args: string[]) => args[1] === 'nodes'
      ? Promise.resolve({ items: [{ metadata: { name: 'n1' } }, { metadata: { name: 'n2' } }] })
      : base(args))
    await expect(ensureNodeImageStore(PROJECT)).resolves.toBe(true)

    const pods = appliedPods()
    expect(pods.map((p) => p.spec.nodeName)).toEqual(['n1', 'n2'])
    const gens = pods.map((p) => /GEN="\$STORE\/(gen-[^"]+)"/.exec(String(p.spec.containers[0].command[2]))?.[1])
    expect(gens[0]).toMatch(/^gen-/)
    expect(new Set(gens).size).toBe(1)
  })

  it('pulls the newest generations of yaac-built repos and nothing a dead one supports', async () => {
    stageLiveCluster()
    await ensureNodeImageStore(PROJECT)
    const storeRoot = await fs.mkdtemp(path.join(tmpDataDir, 'store-'))
    const { pulled, published } = await runStoreWriterScript(podCommand().script, storeRoot, [])

    const gen = (repo: string, which: keyof typeof GENERATIONS) =>
      `${CLUSTER_IP}:5000/${repo}:${GENERATIONS[which]}`
    // The newest two of each yaac repo, with their chain slots.
    expect(pulled).toContain(gen('yaac-tools', 'new'))
    expect(pulled).toContain(gen('yaac-tools', 'mid'))
    expect(pulled).toContain(`${CLUSTER_IP}:5000/yaac-tools:${CACHE_TAG_PREFIX}${GENERATIONS.new}-1`)
    // Not the oldest generation, nor its chain slots.
    expect(pulled).not.toContain(gen('yaac-tools', 'old'))
    expect(pulled.some((r) => r.includes(`${CACHE_TAG_PREFIX}${GENERATIONS.old}`))).toBe(false)
    // yaac-flaky's newest config is unreadable, but it is kept and the
    // oldest is dropped, so a transient fetch failure does not lose the
    // generation the next build would use.
    expect(pulled).toContain(gen('yaac-flaky', 'new'))
    expect(pulled).toContain(gen('yaac-flaky', 'mid'))
    expect(pulled).not.toContain(gen('yaac-flaky', 'old'))
    // Hand-written tags and non-yaac repos are not ranked, matching the
    // registry retention pass, so they are pulled in full.
    expect(pulled).toContain(`${CLUSTER_IP}:5000/podman-stable:v5`)
    expect(pulled).toContain(`${CLUSTER_IP}:5000/myapp:v1`)
    expect(pulled).toContain(`${CLUSTER_IP}:5000/myapp:${CACHE_TAG_PREFIX}v1-1`)
    expect(pulled).toContain(gen('myapp', 'old'))
    // Named images before chain slots, so what a workspace uses is warmed
    // first.
    expect(pulled.indexOf(gen('yaac-tools', 'new')))
      .toBeLessThan(pulled.indexOf(`${CLUSTER_IP}:5000/yaac-tools:${CACHE_TAG_PREFIX}${GENERATIONS.new}-1`))
    expect(published).toBe(true)

    // Tied timestamps: which two survive is arbitrary but must be stable,
    // or every build would churn the store.
    const tied = (rs: string[]) => rs.filter((r) => r.startsWith(`${CLUSTER_IP}:5000/yaac-tied:`))
    expect(tied(pulled)).toHaveLength(CACHED_GENERATIONS_KEPT)
    const again = await runStoreWriterScript(
      podCommand().script, await fs.mkdtemp(path.join(tmpDataDir, 'store-')), [])
    expect(tied(again.pulled)).toEqual(tied(pulled))
  })

  it('whites out a replaced directory ALL THE WAY DOWN, not just its first level', async () => {
    stageLiveCluster()
    await ensureNodeImageStore(PROJECT)
    const storeRoot = await fs.mkdtemp(path.join(tmpDataDir, 'store-'))
    const { whiteouts, published } = await runStoreWriterScript(
      podCommand().script, storeRoot, [], { overlay: true })

    // An opaque dir hides everything below it. Whiting out only the top
    // level would leave `src` merged, and `old.js` would silently reappear.
    expect(whiteouts).toEqual(['app/gone.txt', 'app/src/old.js'])
    expect(whiteouts).not.toContain('untouched.txt')
    expect(published).toBe(true)
  })

  it('publishes nothing when the lower chain it must read is broken', async () => {
    stageLiveCluster()
    await ensureNodeImageStore(PROJECT)
    const storeRoot = await fs.mkdtemp(path.join(tmpDataDir, 'store-'))
    // A `lower` link that does not resolve. Continuing would miss whiteouts
    // and carry the mistake into later generations, so the build fails and
    // the last good generation stays mounted.
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
    // An old complete generation, the newest complete one (which a create
    // may have pinned), and one a crashed build left without a DONE marker.
    const [superseded, newest, partial] = [generationName(1), generationName(2), generationName(3)]
    for (const g of [superseded, newest, partial]) await fs.mkdir(path.join(storeRoot, g))
    for (const g of [superseded, newest]) {
      await fs.writeFile(path.join(storeRoot, g, DONE_MARKER), 'x')
    }

    stageLiveCluster()
    await ensureNodeImageStore(PROJECT)
    // An empty keep list: a create may have picked the newest generation
    // before its pod existed, so that generation must survive anyway.
    const { generations, published, stdout } = await runStoreWriterScript(
      podCommand().script, storeRoot, [])
    expect(published).toBe(true)
    expect(generations).toContain(newest)
    expect(generations).not.toContain(superseded)
    expect(generations).not.toContain(partial)
    expect(stdout).toContain('store-generations kept 2 dropped 2')

    // A layer without a recorded diff size makes `podman images` decompress
    // it (very slow under gVisor), so the build fails before the marker.
    _resetImageStoreForTests()
    mockApply.mockClear()
    await ensureNodeImageStore(PROJECT)
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
    await expect(ensureNodeImageStore(PROJECT, { nowMs: t0 })).resolves.toBe(true)
    await expect(ensureNodeImageStore(PROJECT, { nowMs: t0 + 1000 })).resolves.toBe(false)
    // A push means new content, so it forces a build.
    await expect(ensureNodeImageStore(PROJECT, { nowMs: t0 + 1000, force: true })).resolves.toBe(true)
    // The forced build resets the interval.
    await expect(
      ensureNodeImageStore(PROJECT, { nowMs: t0 + 1000 + STORE_REFRESH_INTERVAL_MS - 1 }),
    ).resolves.toBe(false)
    await expect(
      ensureNodeImageStore(PROJECT, { nowMs: t0 + 1000 + STORE_REFRESH_INTERVAL_MS }),
    ).resolves.toBe(true)
  })

  // Leftover pods from a crashed run are swept before every build.
  it('sweeps strays from a crashed run before building', async () => {
    stageLiveCluster()
    await ensureNodeImageStore(PROJECT)
    const deletes = mockRetry.mock.calls.map((c) => c[0].join(' '))
    expect(deletes.some((d) =>
      d.includes('delete pod') && d.includes('app=yaac-image-store')
      && d.includes(`yaac.project-id=${ID}`),
    )).toBe(true)
  })

  it('is a no-op when the project has no registry to build from', async () => {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      if (args[1] === 'service') return Promise.resolve(null)
      return Promise.resolve({ items: [] })
    })
    await expect(ensureNodeImageStore(PROJECT)).resolves.toBe(false)
    expect(appliedPods()).toHaveLength(0)
  })

  it('retries a failed build on the short backoff, not the full interval', async () => {
    // A failed build is usually transient (often a registry rollout), so
    // it retries soon rather than after a full interval.
    mockGetJson.mockImplementation(() => Promise.resolve(null))
    const t0 = 1_000_000
    await expect(ensureNodeImageStore(PROJECT, { nowMs: t0 })).resolves.toBe(false)
    stageLiveCluster()
    await expect(
      ensureNodeImageStore(PROJECT, { nowMs: t0 + STORE_REFRESH_RETRY_MS - 1 }),
    ).resolves.toBe(false)
    await expect(
      ensureNodeImageStore(PROJECT, { nowMs: t0 + STORE_REFRESH_RETRY_MS }),
    ).resolves.toBe(true)
  })
})

describe('nodeImageStoreMount', () => {
  it('pins the newest COMPLETE generation, read-only', async () => {
    const parent = imageStoreDir(ID)
    const [older, newer, partial] = [generationName(1), generationName(2), generationName(3)]
    for (const g of [older, newer, partial]) await fs.mkdir(path.join(parent, g), { recursive: true })
    for (const g of [older, newer]) await fs.writeFile(path.join(parent, g, DONE_MARKER), 'x')

    // `partial` is newest but has no marker, so it is never used.
    await expect(nodeImageStoreMount(ID)).resolves.toEqual({
      source: { kind: 'hostPath', path: path.join(parent, newer), type: 'DirectoryOrCreate' },
      mountPath: SHARED_IMAGES_MOUNT,
      readOnly: true,
    })
  })

  it('mounts nothing on a cold node', async () => {
    await expect(nodeImageStoreMount(ID)).resolves.toBeUndefined()
    await fs.mkdir(path.join(imageStoreDir(ID), generationName(1)), { recursive: true })
    await expect(nodeImageStoreMount(ID)).resolves.toBeUndefined()
  })
})

describe('reconcileNodeImageStores', () => {
  it('fires one detached build per project', async () => {
    stageLiveCluster()
    const other = { slug: 'other', id: '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9' }
    reconcileNodeImageStores([PROJECT, other])
    // Not awaited: it returns before any pod is applied.
    expect(appliedPods()).toHaveLength(0)
    await vi.waitFor(() => expect(appliedPods()).toHaveLength(2))
    const ids = appliedPods().map((p) => p.metadata.labels['yaac.project-id'])
    expect(new Set(ids)).toEqual(new Set([ID, other.id]))
  })
})
