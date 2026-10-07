/**
 * The image build coordinator: `ensureImage`.
 *
 * Nothing in the images folder is mocked. Trusted-layer routing and the whole
 * builder-pod flow (manifests, in-pod scripts, build argv, context tar) run
 * for real; the fakes are the cluster, kubectl, spawn, podman and the registry.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as childProcessModule from 'node:child_process'
import type * as imageBuilderModule from '#drivers/k8s/image-engine/image-builder'
import type * as mainRegistryModule from '#drivers/k8s/cluster/main-registry'

/**
 * spawn fake: records invocations and returns a child that closes with
 * `spawnState.closeCode` on the next tick. Context file lists are read at
 * spawn time, since builder-pod deletes the list file once tar exits.
 *
 * `spawnState.hold` keeps matching children open so a test controls their
 * output and exit, which is how the idle build timeout is driven.
 */
type FakeStream = EventEmitter & {
  write: (chunk: unknown) => boolean
  pipe: ReturnType<typeof vi.fn>
  setEncoding: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}
interface FakeChild extends EventEmitter {
  stdout: FakeStream
  stderr: FakeStream
  stdin: FakeStream
  pid: number
  /** Null while running; `killGroup` will not signal an exited pid. */
  exitCode: number | null
  signalCode: string | null
}
/** A held child: its output tap, its exit hook, and the signals it got. */
interface HeldChild {
  log: (line: string) => void
  /** Exit with this code. */
  close: (code: number) => void
  signals: string[]
}
/** Fake pids; the process.kill spy keeps them from reaching the OS. */
const FAKE_PID_BASE = 990_001
const spawned = vi.hoisted(() => [] as Array<{ file: string; args: string[]; stdin: string }>)
const held = vi.hoisted(() => [] as HeldChild[])
/** Group pid (negative) -> what the held fake child does when signalled. */
const killers = vi.hoisted(() => new Map<number, (signal: string) => void>())
const spawnState = vi.hoisted(() => ({
  closeCode: 0,
  /** Per-command exit code, for tests where only one step fails. */
  codeFor: null as null | ((file: string, args: string[]) => number | undefined),
  hold: null as null | ((file: string, args: string[]) => boolean),
  /** Announces each held child, so a test can await one instead of polling. */
  onHold: null as null | (() => void),
}))
const tarLists = vi.hoisted(() => [] as string[][])
/** `execFile` children (the builder's `kubectl wait`), and a failure to answer with. */
const execState = vi.hoisted(() => ({ calls: [] as string[][], error: null as Error | null }))
const readListFile = vi.hoisted(() => (listFile: string): string[] => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as { readFileSync: (p: string, enc: string) => string }
  return nodeFs.readFileSync(listFile, 'utf8').split('\n').filter(Boolean)
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcessModule>()
  const fakeStream = (): FakeStream => Object.assign(new EventEmitter(), {
    write: () => true, pipe: vi.fn(), setEncoding: vi.fn(), end: vi.fn(), destroy: vi.fn(),
  })
  return {
    ...actual,
    execFile: (_file: string, args: string[], _opts: unknown, cb: (err: unknown, res?: object) => void) => {
      execState.calls.push(args)
      process.nextTick(() => { cb(execState.error, { stdout: '', stderr: '' }) })
    },
    spawn: (file: string, args: string[]) => {
      const child = new EventEmitter() as FakeChild
      child.stdout = fakeStream()
      child.stderr = fakeStream()
      child.stdin = fakeStream()
      child.pid = FAKE_PID_BASE + spawned.length
      child.exitCode = null
      child.signalCode = null
      if (file === 'tar' && args.includes('-T')) {
        tarLists.push(readListFile(args[args.indexOf('-T') + 1]))
      }
      const entry = { file, args, stdin: '' }
      spawned.push(entry)
      child.stdin.write = (chunk: unknown) => { entry.stdin += String(chunk); return true }
      if (spawnState.hold?.(file, args)) {
        const signals: string[] = []
        killers.set(-child.pid, (signal) => {
          signals.push(signal)
          child.signalCode = signal
          child.emit('exit', null, signal)
          child.emit('close', null, signal)
        })
        held.push({
          signals,
          log: (line) => child.stdout.emit('data', `${line}\n`),
          close: (code) => { child.exitCode = code; child.emit('close', code) },
        })
        spawnState.onHold?.()
      } else {
        const code = spawnState.codeFor?.(file, args) ?? spawnState.closeCode
        process.nextTick(() => child.emit('close', code))
      }
      return child
    },
  }
})

// Only chain resolution and the host build are faked; context collection
// and .containerignore handling run for real, since builder-pod uses them.
vi.mock('#drivers/k8s/image-engine/image-builder', async (importOriginal) => ({
  ...(await importOriginal<typeof imageBuilderModule>()),
  buildImage: vi.fn(),
  resolveImageChain: vi.fn(),
}))

vi.mock('#drivers/k8s/container/runtime', () => ({
  imageExists: vi.fn().mockResolvedValue(false),
}))

vi.mock('#drivers/k8s/container/registry', () => ({
  pushImageToRegistry: vi.fn(),
  registryHasTag: vi.fn().mockResolvedValue(false),
  registryHost: vi.fn(() => 'yaac-registry.yaac.svc.cluster.local:5000'),
  registryRef: vi.fn((tag: string) => `yaac-registry.yaac.svc.cluster.local:5000/${tag}`),
}))

vi.mock('#drivers/k8s/cluster/cluster-cidrs', () => ({
  nodeIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
  resetClusterCidrCache: vi.fn(),
}))

const mockEnsureMainRegistry = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/cluster/main-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof mainRegistryModule>()),
  ensureMainRegistry: mockEnsureMainRegistry,
}))

// serverLog is silenced, but line splitting is kept: in-pod build output
// reaches the build registry through it.
vi.mock('#log', () => ({
  serverLog: vi.fn(),
  pipeToServerLog: (
    stream: NodeJS.ReadableStream | null,
    _prefix: string,
    onLine?: (line: string) => void,
  ) => {
    let buf = ''
    stream?.on('data', (chunk: string) => {
      buf += chunk
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (line.length > 0) onLine?.(line)
      }
    })
  },
}))

import { ensureImage } from '#drivers/k8s/images/build-coordinator'
import { _clearBuildCoordinatorForTests } from '#drivers/k8s/images/build-coordinator'
import { buildImage, resolveImageChain, type ImageLayer } from '#drivers/k8s/image-engine/image-builder'
import { imageExists } from '#drivers/k8s/container/runtime'
import { pushImageToRegistry, registryHasTag } from '#drivers/k8s/container/registry'
import { clearAllImageBuildsForTests, listImageBuilds } from '#drivers/k8s/image-engine/image-builds'
// Setup values, not units under test.
import {
  BUILDER_ACTIVE_DEADLINE_SECONDS,
  BUILDER_AUTHFILE,
  BUILDER_BUILD_IDLE_TIMEOUT_MS,
  BUILDER_CONTEXT_DIR,
  BUILDER_GRAPHROOT_SIZELIMIT_BYTES,
  BUILDER_GRAPHROOT_TMPFS_BYTES,
  BUILDER_CPU_REQUEST_MILLIS,
  BUILDER_MEMORY_LIMIT_BYTES,
  BUILDER_MEMORY_REQUEST_BYTES,
} from '#drivers/k8s/images/builder-pod'
import { BUILDER_LOCAL_TAG } from '#drivers/k8s/cluster/builder-image'
import { egressAllButServerFront } from '#drivers/k8s/cluster/policy-manifests'
import { BUILDER_CONTEXT_MAX_BYTES } from '#lib/build-context'
import { _resetRegistryGrantKeyForTests } from '#drivers/k8s/container/registry-grant'
import { dataDirHash, k8sNamespace } from '#drivers/k8s/substrate'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import type { ImageLayerName } from '@yaac/shared/types'

const mockBuildImage = vi.mocked(buildImage)
const mockResolveChain = vi.mocked(resolveImageChain)
const mockImageExists = vi.mocked(imageExists)
const mockPush = vi.mocked(pushImageToRegistry)
const mockHasTag = vi.mocked(registryHasTag)

const CLUSTER_HOST = 'yaac-registry.yaac.svc.cluster.local:5000'

/** The cluster's registry grant key, seeded as its Secret. */
const GRANT_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey

/**
 * Verify a builder pod's authfile grant as the registry's write gate does.
 * Returns its scope, or null for a bad signature.
 */
function grantScopeOf(authFile: string): { repos: string[]; expiry: number } | null {
  const { auths } = JSON.parse(authFile) as { auths: Record<string, { auth: string }> }
  const basic = Buffer.from(auths[CLUSTER_HOST].auth, 'base64').toString()
  const password = basic.slice(basic.indexOf(':') + 1)
  const dot = password.lastIndexOf('.')
  const payload = password.slice(0, dot)
  if (!crypto.verify('sha256', Buffer.from(payload), GRANT_KEY, Buffer.from(password.slice(dot + 1), 'base64url'))) {
    return null
  }
  const [, expiry, scope] = payload.split('|')
  return { repos: scope.split(','), expiry: Number(expiry) }
}
const PROJ = '3f2c9a1e-5b7d-4c8e-9f01-2a3b4c5d6e7f'
/** The projects' owner, whose Dockerfile.user tops each chain. */
const OWNER = 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d'
const PROJ_A = '0b6f1d2c-3e4a-4b5c-8d9e-0f1a2b3c4d5e'
const PROJ_B = 'c1d2e3f4-a5b6-4c7d-8e9f-a0b1c2d3e4f5'
const LAYERED_DOCKERFILE = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'

/**
 * A yaac-shipped layer. `yaac cluster install` builds these; here they are
 * only looked up, so the paths can be fake.
 */
function layer(tag: string, name: ImageLayerName = 'base'): ImageLayer {
  return { tag, name, dockerfile: '/df', context: '/ctx', contentHash: 'h' }
}

const tmpDirs: string[] = []
async function makeContext(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-coord-test-'))
  tmpDirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await fs.writeFile(path.join(dir, rel), content)
  }
  return dir
}

/** An untrusted layer over a real on-disk context — builds in a pod. */
async function podLayer(over: Partial<ImageLayer> = {}, files?: Record<string, string>): Promise<ImageLayer> {
  const dir = await makeContext(files ?? { 'Dockerfile.yaac': LAYERED_DOCKERFILE })
  return {
    tag: `yaac-proj-${PROJ}:p1`,
    name: 'project',
    dockerfile: path.join(dir, 'Dockerfile.yaac'),
    context: dir,
    buildArgs: { BASE_IMAGE: 'yaac-tools:t1' },
    contentHash: 'p1',
    ...over,
  }
}

function chain(layers: ImageLayer[]): void {
  mockResolveChain.mockResolvedValue({ layers, finalTag: layers.at(-1)!.tag })
}

interface PodManifest {
  metadata: { name: string; namespace: string; labels: Record<string, string>; annotations: Record<string, string> }
  spec: {
    restartPolicy: string
    activeDeadlineSeconds: number
    automountServiceAccountToken: boolean
    enableServiceLinks: boolean
    runtimeClassName: string
    priorityClassName: string
    securityContext: { seccompProfile: { type: string } }
    containers: Array<{
      image: string
      imagePullPolicy: string
      command: string[]
      securityContext: { capabilities: { add: string[] } }
      resources: {
        requests: Record<string, string>
        limits: { memory: string }
      }
      volumeMounts: Array<{ name: string; mountPath: string }>
    }>
    volumes: Array<{ name: string; emptyDir: { sizeLimit: string } }>
  }
}

/** Each applied object, in order. */
const appliedObjects = (): Array<{ kind: string }> =>
  fakeCluster.callsOf('apply').map((c) => c.body as unknown as { kind: string })

const appliedKinds = (): string[] => appliedObjects().map((m) => m.kind)

function appliedOfKind<T>(kind: string): T {
  const found = appliedObjects().find((m) => m.kind === kind)
  expect(found, `no ${kind} was applied`).toBeDefined()
  return found as T
}

/** The remote argv of each in-pod `kubectl exec`, in order. */
const remoteCommands = (): string[][] =>
  spawned.filter((s) => s.file === 'kubectl')
    .map((s) => s.args.slice(s.args.indexOf('--') + 1))

/** The builder pods deleted, by name. */
const deleteCalls = (): Array<string | undefined> => fakeCluster.callsOf('delete', 'Pod').map((c) => c.name)

/** Every builder pod applied from here on reports `status`. */
function podStatus(status: object): void {
  fakeCluster.intercept((c) => {
    if (c.verb === 'apply' && c.kind === 'Pod') c.body = { ...c.body, status }
  })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
  _clearBuildCoordinatorForTests()
  clearAllImageBuildsForTests()
  spawned.length = 0
  tarLists.length = 0
  held.length = 0
  killers.clear()
  spawnState.closeCode = 0
  spawnState.codeFor = null
  spawnState.hold = null
  spawnState.onHold = null
  // Held children are killed by -pid (the group).
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: string) => {
    const die = killers.get(pid)
    if (!die) throw new Error(`ESRCH: unexpected process.kill(${pid})`)
    die(signal)
    return true
  }) as typeof process.kill)
  mockImageExists.mockResolvedValue(false)
  // Only the pinned podman-stable mirror is in the registry, so
  // `ensureBuilderImage` resolves without pulling or pushing.
  mockHasTag.mockImplementation((tag: string) => Promise.resolve(tag === BUILDER_LOCAL_TAG))
  mockEnsureMainRegistry.mockResolvedValue(undefined)
  execState.calls.length = 0
  execState.error = null
  fakeCluster.seed({
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: 'yaac-registry-grant-key', namespace: 'yaac-registry-keys' },
    data: { 'key.pem': Buffer.from(GRANT_KEY.export({ type: 'pkcs8', format: 'pem' })).toString('base64') },
  })
  _resetRegistryGrantKeyForTests()
})

afterEach(async () => {
  _clearBuildCoordinatorForTests()
  clearAllImageBuildsForTests()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('ensureImage', () => {
  /**
   * Hold every in-pod `podman build` open, and return a waiter for the next
   * one to start.
   */
  function holdInPodBuilds(): () => Promise<void> {
    spawnState.hold = (file, args) => file === 'kubectl' && args.includes('build')
    return () => {
      const seen = held.length
      return new Promise<void>((resolve) => {
        spawnState.onHold = () => { if (held.length > seen) resolve() }
      })
    }
  }

  it('coalesces a shared layer across chains and fans out the distinct ones', async () => {
    const shared = await podLayer({ tag: 'yaac-base:shared', buildArgs: undefined })
    mockResolveChain.mockImplementation(async (projectId) => ({
      layers: [shared, await podLayer({
        tag: `yaac-user-${projectId}:x`, name: 'user', buildArgs: { BASE_IMAGE: shared.tag },
      })],
      finalTag: `yaac-user-${projectId}:x`,
    }))
    const nextBuild = holdInPodBuilds()

    const a = ensureImage(PROJ_A, OWNER, undefined, false, false, { reason: 'prewarm' })
    const b = ensureImage(PROJ_B, OWNER, undefined, false, false, { reason: 'prewarm' })

    // Both chains wait on one shared build and attach to its single entry.
    // Which project registered first is a race, so compare ids as a set.
    await nextBuild()
    await flush()
    expect(held).toHaveLength(1)
    const entries = listImageBuilds()
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('running')
    expect([...entries[0].projectIds].sort()).toEqual([PROJ_A, PROJ_B].sort())

    // Once the shared layer finishes, both downstream layers build.
    held[0].close(0)
    await vi.waitFor(() => { expect(held.length).toBe(3) })

    for (const h of held.slice(1)) h.close(0)
    expect(await a).toBe(`yaac-user-${PROJ_A}:x`)
    expect(await b).toBe(`yaac-user-${PROJ_B}:x`)
    expect(listImageBuilds().every((e) => e.status === 'succeeded')).toBe(true)
  })

  it('propagates a build failure to every waiter and marks the entry failed', async () => {
    const project = await podLayer({ tag: 'yaac-base:x', buildArgs: undefined })
    chain([project])
    const nextBuild = holdInPodBuilds()
    const a = ensureImage(PROJ_A, OWNER)
    const b = ensureImage(PROJ_B, OWNER)

    await nextBuild()
    await flush()
    expect(held).toHaveLength(1)
    held[0].close(1)
    await expect(a).rejects.toThrow(/exit(ed with)? code 1/)
    await expect(b).rejects.toThrow(/exit(ed with)? code 1/)

    expect(listImageBuilds()[0]).toMatchObject({ status: 'failed' })
    // A failed tag is not remembered as built, so the next ensure retries.
    const retry = nextBuild()
    const again = ensureImage(PROJ_A, OWNER)
    await retry
    await flush()
    held.at(-1)!.close(0)
    await again
  })

  it('fans build output into the registry log', async () => {
    chain([await podLayer({ tag: 't:1', buildArgs: undefined })])
    const nextBuild = holdInPodBuilds()
    const done = ensureImage(PROJ, OWNER)

    await nextBuild()
    held[0].log('STEP 1/2: FROM ubuntu')
    held[0].close(0)
    await done

    expect(listImageBuilds()[0]).toMatchObject({ stepCurrent: 1, stepTotal: 2 })
  })

  it('skips present tags and memoizes the verification for the rest of the run', async () => {
    const first = await podLayer({ tag: 't:1', buildArgs: undefined })
    const second = await podLayer({ tag: 't:2', name: 'user', buildArgs: undefined })
    chain([first, second])
    mockHasTag.mockImplementation((tag: string) =>
      Promise.resolve(tag === 't:1' || tag === BUILDER_LOCAL_TAG))

    await ensureImage(PROJ, OWNER)
    // Only the absent layer built; both tags were probed once.
    expect(appliedKinds().filter((k) => k === 'Pod')).toHaveLength(1)
    expect(mockHasTag.mock.calls.filter(([tag]) => tag === 't:1')).toHaveLength(1)

    // Content-hash tags never change, so neither tag is re-checked.
    mockHasTag.mockClear()
    fakeCluster.calls = []
    await ensureImage(PROJ, OWNER)
    expect(mockHasTag.mock.calls.filter(([tag]) => tag === 't:1' || tag === 't:2')).toEqual([])
    expect(appliedKinds()).not.toContain('Pod')
  })

  it('reports layer starts with 1-based chain positions', async () => {
    chain([
      await podLayer({ tag: 't:1', buildArgs: undefined }),
      await podLayer({ tag: 't:2', name: 'user', buildArgs: undefined }),
    ])
    const starts: string[] = []
    await ensureImage(PROJ, OWNER, undefined, false, false, {
      onLayerStart: (i, total, name) => starts.push(`${i}/${total} ${name}`),
    })
    expect(starts).toEqual(['1/2 project', '2/2 user'])
  })

  it('throws under requirePrebuilt without building or registering', async () => {
    chain([layer('t:1')])
    await expect(ensureImage(PROJ, OWNER, undefined, true)).rejects.toThrow('missing or stale')
    expect(appliedKinds()).not.toContain('Pod')
    expect(listImageBuilds()).toEqual([])
  })

  it('refuses a yaac-shipped layer the registry does not have, naming the install', async () => {
    // The server cannot build base/tools/nestable, so the error names the
    // command that does.
    chain([layer('yaac-base:missing')])
    await expect(ensureImage(PROJ, OWNER)).rejects.toThrow(
      /yaac-base:missing is missing from the local registry.*yaac cluster install/s,
    )
    expect(appliedKinds()).not.toContain('Pod')
    expect(listImageBuilds()[0]).toMatchObject({ status: 'failed' })
  })

  it('builds an untrusted layer in a gvisor builder pod and pushes the product', async () => {
    // The whole builder-pod path: manifest, storage setup, parent pull,
    // context tar, cached build, push, teardown.
    const tools = layer('yaac-tools:t1', 'tools')
    const project = await podLayer({}, {
      'Dockerfile.yaac': LAYERED_DOCKERFILE,
      'keep.txt': 'k',
      'skipped/file.txt': 's',
      '.containerignore': 'skipped\n',
    })
    chain([tools, project])
    // The yaac-shipped parent is already in the registry, where the pod
    // pulls it from. Only the pod pushes; this process pushes nothing.
    mockHasTag.mockImplementation((tag: string) =>
      Promise.resolve(tag === tools.tag || tag === BUILDER_LOCAL_TAG))

    await ensureImage(PROJ, OWNER)

    expect(mockBuildImage).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()

    expect(mockEnsureMainRegistry).toHaveBeenCalled()
    expect(appliedKinds()).toEqual(expect.arrayContaining([
      'ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding', 'NetworkPolicy', 'Pod',
    ]))

    const pod = appliedOfKind<PodManifest>('Pod')
    expect(pod.metadata.name).toMatch(/^yaac-builder-[0-9a-f]{8}-[0-9a-f]{4}$/)
    expect(pod.metadata.namespace).toBe(k8sNamespace())
    expect(pod.metadata.labels).toEqual({
      'yaac.data-dir-hash': dataDirHash(),
      'yaac.role': 'builder',
    })
    expect(pod.spec.runtimeClassName).toBe('gvisor')
    // Outranks workspaces for eviction, but never preempts a running one.
    expect(pod.spec.priorityClassName).toBe('yaac-builder')
    expect(pod.spec.restartPolicy).toBe('Never')
    expect(pod.spec.activeDeadlineSeconds).toBe(BUILDER_ACTIVE_DEADLINE_SECONDS)
    expect(pod.spec.automountServiceAccountToken).toBe(false)
    expect(pod.spec.enableServiceLinks).toBe(false)
    expect(pod.spec.securityContext.seccompProfile.type).toBe('RuntimeDefault')
    expect(pod.spec.containers[0].resources.limits.memory).toBe(String(BUILDER_MEMORY_LIMIT_BYTES))
    // An explicit request well under the limit; Kubernetes would otherwise
    // default the request to the full 8Gi limit.
    expect(pod.spec.containers[0].resources.requests).toEqual({
      cpu: `${BUILDER_CPU_REQUEST_MILLIS}m`,
      memory: String(BUILDER_MEMORY_REQUEST_BYTES),
    })
    expect(BUILDER_MEMORY_REQUEST_BYTES).toBeLessThan(BUILDER_MEMORY_LIMIT_BYTES)
    expect(pod.spec.containers[0].command).toEqual(['sleep', 'infinity'])
    // The pinned podman-stable mirror, never the user-customizable image.
    expect(pod.spec.containers[0].image).toBe(`${CLUSTER_HOST}/${BUILDER_LOCAL_TAG}`)
    expect(pod.spec.containers[0].imagePullPolicy).toBe('IfNotPresent')
    expect(pod.spec.containers[0].securityContext.capabilities.add).toContain('SETFCAP')
    // Graphroot on a gVisor tmpfs emptyDir.
    expect(pod.metadata.annotations['dev.gvisor.spec.mount.podman-graphroot.type']).toBe('bind')
    expect(pod.metadata.annotations['dev.gvisor.spec.mount.podman-graphroot.options'])
      .toBe(`rw,size=${BUILDER_GRAPHROOT_TMPFS_BYTES}`)
    expect(pod.spec.volumes).toEqual([{
      name: 'podman-graphroot',
      emptyDir: { sizeLimit: String(BUILDER_GRAPHROOT_SIZELIMIT_BYTES) },
    }])
    expect(pod.spec.containers[0].volumeMounts).toEqual([{
      name: 'podman-graphroot', mountPath: '/var/lib/containers',
    }])

    const np = appliedOfKind<{
      spec: { podSelector: { matchLabels: Record<string, string> }; policyTypes: string[]; egress: unknown[] }
    }>('NetworkPolicy')
    expect(np.spec.podSelector.matchLabels).toEqual({ 'yaac.role': 'builder' })
    expect(np.spec.policyTypes).toEqual(['Egress'])
    // Anywhere except the kind fronting's node port: a RUN step comes from
    // an agent-editable Dockerfile, and the server would see it as the node.
    expect(np.spec.egress).toEqual(egressAllButServerFront(['10.89.0.7/32']))

    // storage.conf bootstrap, parent pull, extract, grant, build, push — in order.
    const remote = remoteCommands()
    expect(remote).toHaveLength(6)
    // Native overlay: the stock image's fuse-overlayfs is broken on gVisor.
    expect(remote[0][2]).toContain('driver = "overlay"')
    expect(remote[0][2]).not.toContain('fuse-overlayfs')
    expect(remote[0][2]).toContain('enable_partial_images = "true"')
    expect(remote[0][2]).toContain('graphroot = "/var/lib/containers/storage"')
    // Parent retagged to the bare tag so --build-arg BASE_IMAGE matches.
    expect(remote[1][2]).toContain(`podman pull --tls-verify=false ${CLUSTER_HOST}/${tools.tag}`)
    expect(remote[1][2]).toContain(`podman tag ${CLUSTER_HOST}/${tools.tag} ${tools.tag}`)
    expect(remote[1][2]).toContain(`if podman image exists ${tools.tag}; then exit 0; fi`)
    expect(remote[2][2]).toContain(`tar -xf - -C ${BUILDER_CONTEXT_DIR}`)
    // The write grant arrives over stdin, not argv, and covers only the
    // product's repo and the project's step-cache repo.
    expect(remote[3][2]).toBe(`umask 077 && cat > ${BUILDER_AUTHFILE}`)
    const grantExec = spawned.filter((s) => s.file === 'kubectl')[3]
    const grant = grantScopeOf(grantExec.stdin)
    expect(grant?.repos).toEqual([`yaac-proj-${PROJ}`, `yaac-buildcache-${PROJ}`])
    // Valid for the pod's maximum lifetime, and not much longer.
    expect(grant!.expiry - Date.now() / 1000).toBeGreaterThan(BUILDER_ACTIVE_DEADLINE_SECONDS)
    expect(grant!.expiry - Date.now() / 1000).toBeLessThan(BUILDER_ACTIVE_DEADLINE_SECONDS + 120)
    expect(grantExec.args.join(' ')).not.toContain(grantExec.stdin)
    // Build: chroot isolation, per-project registry step cache.
    expect(remote[4].slice(0, 4)).toEqual(['podman', 'build', '--isolation', 'chroot'])
    expect(remote[4]).toContain(project.tag)
    const cacheRef = `${CLUSTER_HOST}/yaac-buildcache-${PROJ}`
    expect(remote[4].join(' '))
      .toContain(`--cache-from ${cacheRef} --cache-to ${cacheRef} --cache-ttl 168h`)
    expect(remote[4].join(' ')).toContain(`--authfile ${BUILDER_AUTHFILE}`)
    expect(remote[4].join(' ')).toContain(`-f ${BUILDER_CONTEXT_DIR}/Dockerfile.yaac`)
    expect(remote[4].join(' ')).toContain(`--build-arg BASE_IMAGE=${tools.tag}`)
    expect(remote[4].at(-1)).toBe(BUILDER_CONTEXT_DIR)
    expect(remote[5].slice(0, 5)).toEqual(['podman', 'push', '--tls-verify=false', '--authfile', BUILDER_AUTHFILE])
    expect(remote[5]).toContain(`${CLUSTER_HOST}/${project.tag}`)

    // The context honors .containerignore exactly like contextHash().
    expect(tarLists[0]).toEqual(expect.arrayContaining(['keep.txt', '.containerignore', 'Dockerfile.yaac']))
    expect(tarLists[0].some((f) => f.startsWith('skipped/'))).toBe(false)

    // ensureImage owns the lease, so the pod is deleted after the chain.
    expect(deleteCalls()).toEqual([pod.metadata.name])
  })

  it('ships a parentless layer without a pull, and its dockerfile even when ignored', async () => {
    const project = await podLayer(
      { buildArgs: { HTTP_PROXY: 'http://proxy:8080' } },
      { 'Dockerfile.yaac': 'FROM ubuntu\n', '.containerignore': 'Dockerfile.yaac\n' },
    )
    chain([project])
    await ensureImage(PROJ, OWNER)

    const scripts = remoteCommands().map((argv) => argv.join(' '))
    expect(scripts.some((s) => s.includes('podman pull'))).toBe(false)
    expect(scripts.some((s) => s.includes('--build-arg HTTP_PROXY=http://proxy:8080'))).toBe(true)
    expect(mockPush).not.toHaveBeenCalled()
    // The Dockerfile is always sent, ignore file or not.
    expect(tarLists[0]).toContain('Dockerfile.yaac')
  })

  it('names the step-cache repo by the project id, never its name', async () => {
    // A project re-added under an old name must not hit the old cache.
    chain([await podLayer({ buildArgs: undefined })])
    await ensureImage(PROJ_B, OWNER)
    const build = remoteCommands()[3].join(' ')
    expect(build).toContain(`${CLUSTER_HOST}/yaac-buildcache-${PROJ_B}`)
    expect(build).not.toContain('buildcache-demo')
  })

  it('reuses one builder pod across adjacent untrusted layers and deletes it once', async () => {
    const first = await podLayer({ buildArgs: undefined })
    const second = await podLayer({
      tag: `yaac-user-${PROJ}:u1`, name: 'user', buildArgs: { BASE_IMAGE: first.tag },
    })
    chain([first, second])

    await ensureImage(PROJ, OWNER)

    expect(appliedKinds().filter((k) => k === 'Pod')).toHaveLength(1)
    expect(deleteCalls()).toHaveLength(1)
    // A shared pod gets a fresh grant per layer, for that layer's repo only.
    const grants = spawned
      .filter((s) => s.file === 'kubectl' && s.args.at(-1)?.includes(BUILDER_AUTHFILE) && s.args.at(-1)?.startsWith('umask'))
      .map((s) => grantScopeOf(s.stdin)?.repos)
    expect(grants).toEqual([
      [`yaac-proj-${PROJ}`, `yaac-buildcache-${PROJ}`],
      [`yaac-user-${PROJ}`, `yaac-buildcache-${PROJ}`],
    ])
  })

  it('consults the registry for untrusted tags, never the host store', async () => {
    const tools = layer('yaac-tools:t1', 'tools')
    const project = await podLayer()
    chain([tools, project])
    mockImageExists.mockResolvedValue(true)
    mockHasTag.mockResolvedValue(true) // project tag already in the registry

    await ensureImage(PROJ, OWNER)
    expect(mockHasTag).toHaveBeenCalledWith(project.tag)
    expect(appliedKinds()).not.toContain('Pod')
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('sandboxes any non-whitelisted layer name', async () => {
    // An unknown layer name must not fall through to host podman.
    chain([await podLayer({ name: 'some-future-layer' as ImageLayerName, buildArgs: undefined })])
    await ensureImage(PROJ, OWNER)
    expect(appliedKinds()).toContain('Pod')
    expect(mockBuildImage).not.toHaveBeenCalled()
  })

  it('fails closed when the ValidatingAdmissionPolicy API is unavailable', async () => {
    fakeCluster.removeKind('ValidatingAdmissionPolicy')
    chain([await podLayer({ buildArgs: undefined })])
    await expect(ensureImage(PROJ, OWNER)).rejects.toThrow(/ValidatingAdmissionPolicy/)
    // Without the guard the builder label could be forged, so no pod.
    expect(appliedKinds()).not.toContain('Pod')
  })

  it('maps an unreachable cluster to a `yaac cluster check` pointer', async () => {
    fakeCluster.unreachable = new Error('no cluster')
    chain([await podLayer({ buildArgs: undefined })])
    await expect(ensureImage(PROJ, OWNER)).rejects.toThrow(/yaac cluster check/)
  })

  it('explains a Ready timeout with whatever the pod status accounts for', async () => {
    // A bare `kubectl wait` timeout looks like a broken build, but an
    // unschedulable pod is far more likely.
    execState.error = new Error('timed out')
    podStatus({
      conditions: [{
        type: 'PodScheduled', status: 'False', reason: 'Unschedulable',
        message: '0/1 nodes are available: 1 Insufficient memory.',
      }],
    })
    chain([await podLayer({ buildArgs: undefined })])
    await expect(ensureImage(PROJ, OWNER))
      .rejects.toThrow(/not scheduled \(Unschedulable\): 0\/1 nodes are available/)
    // The pod is deleted even though setup failed.
    expect(deleteCalls().length).toBeGreaterThan(0)

    // A container stuck pulling is named the same way.
    _clearBuildCoordinatorForTests()
    podStatus({
      conditions: [{ type: 'PodScheduled', status: 'True' }],
      containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }],
    })
    chain([await podLayer({ tag: 'yaac-base:p2', buildArgs: undefined })])
    await expect(ensureImage(PROJ, OWNER)).rejects.toThrow(/container waiting \(ImagePullBackOff\)/)

    // An uninformative status leaves the bare timeout.
    _clearBuildCoordinatorForTests()
    podStatus({})
    chain([await podLayer({ tag: 'yaac-base:p3', buildArgs: undefined })])
    await expect(ensureImage(PROJ, OWNER)).rejects.toThrow('timed out')
  })

  it('kills an in-pod build only once it stops producing output', async () => {
    // The timeout is on idle time: a slow build that keeps logging
    // survives, and only silence ends it.
    spawnState.hold = (file, args) => file === 'kubectl' && args.includes('build')
    const reachedBuild = new Promise<void>((r) => { spawnState.onHold = r })
    chain([await podLayer({ buildArgs: undefined })])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const build = ensureImage(PROJ, OWNER)
    const settled = vi.fn()
    void build.then(settled, settled)

    // The steps before the build do real filesystem IO, so wait for them.
    await reachedBuild
    expect(held).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(BUILDER_BUILD_IDLE_TIMEOUT_MS - 1_000)
    held[0].log('STEP 2/5: RUN cargo build --release')
    await vi.advanceTimersByTimeAsync(BUILDER_BUILD_IDLE_TIMEOUT_MS - 1_000)
    expect(settled).not.toHaveBeenCalled()
    expect(held[0].signals).toEqual([])

    await vi.advanceTimersByTimeAsync(2_000)
    await expect(build).rejects.toThrow(
      /builder exec \[podman build .*\] produced no output for 600s/,
    )
    expect(held[0].signals).toEqual(['SIGTERM'])
    // The pod is released, not leaked.
    expect(deleteCalls().length).toBeGreaterThan(0)
  })

  it('blames the whole-pod deadline when the pod dies under the build', async () => {
    // A chatty build is ended by the pod's deadline. kubectl can report
    // only a signal, so the reason comes from the pod's status.
    spawnState.codeFor = (file, args) =>
      (file === 'kubectl' && args.includes('build') ? 137 : undefined)
    podStatus({ phase: 'Failed', reason: 'DeadlineExceeded' })
    chain([await podLayer({ buildArgs: undefined })])

    await expect(ensureImage(PROJ, OWNER)).rejects.toThrow(
      /exited with code 137[\s\S]*stopped at the whole-pod deadline/,
    )
  })

  it('rejects a dockerfile outside its context, and an oversized context', async () => {
    const dir = await makeContext({ 'Dockerfile.yaac': 'FROM x' })
    chain([{
      tag: 'yaac-base:o1', name: 'project', dockerfile: '/elsewhere/Dockerfile',
      context: dir, contentHash: 'o1',
    }])
    await expect(ensureImage(PROJ, OWNER)).rejects.toThrow(/outside its build context/)

    _clearBuildCoordinatorForTests()
    // Sparse file: st_size crosses the cap without touching the disk.
    const fh = await fs.open(path.join(dir, 'big.bin'), 'w')
    await fh.truncate(BUILDER_CONTEXT_MAX_BYTES + 1)
    await fh.close()
    chain([{
      tag: 'yaac-base:o2', name: 'project', dockerfile: path.join(dir, 'Dockerfile.yaac'),
      context: dir, contentHash: 'o2',
    }])
    await expect(ensureImage(PROJ, OWNER)).rejects.toThrow(/\.containerignore/)
  })
})
