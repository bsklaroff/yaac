/**
 * The k8s driver's image verbs: `resolveChain`, `missingImageLayers`,
 * `buildImageLayers` and `imageRef`.
 *
 * Nothing in the images folder is mocked. Chain resolution and the whole
 * builder-pod flow (manifests, in-pod scripts, build argv, context tar) run
 * for real; the fakes are the cluster, kubectl, spawn and the registry.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as childProcessModule from 'node:child_process'
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

vi.mock('#drivers/k8s/cluster/cluster-cidrs', () => ({
  nodeIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
  nodeAddressBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32', '5.75.1.7/32']),
  clusterDnsCidrs: vi.fn().mockResolvedValue(['10.96.0.10/32']),
  resetClusterCidrCache: vi.fn(),
}))

const mockEnsureMainRegistry = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/cluster/main-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof mainRegistryModule>()),
  ensureMainRegistry: mockEnsureMainRegistry,
}))

// serverLog is silenced, but line splitting is kept: in-pod build output
// reaches the build registry through it.
vi.mock('#lib/log', () => ({
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

import {
  _clearBuildCoordinatorForTests,
  buildImageLayers,
  imageRef,
  missingImageLayers,
  resolveChain,
} from '#drivers/k8s/images/build-coordinator'
import { buildBuilderEgressNpManifest, resolveTrustedLayers, stringHash } from '#drivers/k8s/cluster'
import { fakeRegistry } from '#test/support/fake-registry'
// Setup values, not units under test.
import {
  BUILDER_ACTIVE_DEADLINE_SECONDS,
  BUILDER_AUTHFILE,
  BUILDER_BUILD_IDLE_TIMEOUT_MS,
  BUILDER_CONTEXT_DIR,
  BUILDER_DOCKERFILE_DIR,
  BUILDER_STATE_SIZELIMIT_BYTES,
  BUILDER_STATE_TMPFS_BYTES,
  BUILDER_CPU_REQUEST_MILLIS,
  BUILDER_MEMORY_LIMIT_BYTES,
  BUILDER_MEMORY_REQUEST_BYTES,
  BUILD_CACHE_MAX_DAYS,
  cacheBucket,
} from '#drivers/k8s/images/builder-pod'
import { resolveBuilderImageTag } from '#drivers/k8s/cluster/builder-image'
import { NORMALIZE_STEP } from '#drivers/k8s/cluster/normalize-step'
import { BUILDER_CONTEXT_MAX_BYTES } from '#lib/build-context'
import { _resetRegistryGrantKeyForTests } from '#drivers/k8s/cluster/registry-grant'
import { resetProxyClusterIpCache } from '#drivers/k8s/cluster/proxy-apply'
import { proxyClient } from '#drivers/k8s/egress'
import { installId, k8sNamespace } from '#drivers/k8s/substrate'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import type { ImageBuildRequest, ImageChainSpec, ImageLayerSource } from '#drivers/contract'
import type { ImageLayerName } from '@yaac/shared/types'

const CLUSTER_HOST = 'yaac-registry.yaac.svc.cluster.local:5000'
/** The registry's pod port, which builder pods dial. */
const POD_HOST = 'yaac-registry.yaac.svc.cluster.local:5002'

/** The cluster's registry grant key, seeded as its Secret. */
const GRANT_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey

/**
 * Verify a builder pod's authfile grant as the registry's write gate does.
 * Returns its scope, or null for a bad signature.
 */
function grantScopeOf(authFile: string): { repos: string[]; expiry: number } | null {
  const { auths } = JSON.parse(authFile) as { auths: Record<string, { auth: string }> }
  const basic = Buffer.from(auths[POD_HOST].auth, 'base64').toString()
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
const PROJ_B = 'c1d2e3f4-a5b6-4c7d-8e9f-a0b1c2d3e4f5'
/** The build's egress registration id, which labels its pod. */
const EGRESS_ID = '7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6'
const PROXY_IP = '10.96.7.7'
let ensureProxy: ReturnType<typeof vi.spyOn>
const LAYERED_DOCKERFILE = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'

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

/** The project image whose cache the layers below read and write. */
const IMAGE = '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9'

/** An untrusted layer's source over a real on-disk context. */
async function source(
  layer: ImageLayerSource['layer'],
  dockerfile = LAYERED_DOCKERFILE,
  files: Record<string, string> = {},
): Promise<ImageLayerSource> {
  return {
    layer, dockerfile, contextDir: await makeContext(files),
    contentHash: stringHash(dockerfile + JSON.stringify(files)), cacheKey: IMAGE,
  }
}

function spec(...layers: ImageLayerSource[]): ImageChainSpec {
  return { projectId: PROJ, layers }
}

/** What a request reported, beside its outcome. */
interface Seen { starts: ImageLayerName[]; lines: string[] }

function request(
  chainSpec: ImageChainSpec,
  layers: ImageLayerName[],
  over: Partial<ImageBuildRequest> = {},
): { req: ImageBuildRequest; seen: Seen } {
  const seen: Seen = { starts: [], lines: [] }
  return {
    seen,
    req: {
      spec: chainSpec,
      layers,
      egressId: EGRESS_ID,
      allowedHosts: ['deb.debian.org'],
      noCache: false,
      cacheMaxDays: BUILD_CACHE_MAX_DAYS,
      signal: new AbortController().signal,
      onLayerStart: (l) => seen.starts.push(l),
      onLine: (l, line) => seen.lines.push(`${l}: ${line}`),
      ...over,
    },
  }
}

/** A layered project image, its trusted parents already in the registry. */
async function layeredProject(files?: Record<string, string>): Promise<ImageChainSpec> {
  const { base, tools } = await resolveTrustedLayers()
  fakeRegistry.tags.add(base.tag).add(tools.tag)
  return spec(await source('project', LAYERED_DOCKERFILE, files))
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
    dnsPolicy: string
    dnsConfig: { nameservers: string[] }
    containers: Array<{
      image: string
      imagePullPolicy: string
      command: string[]
      env: Array<{ name: string; value: string }>
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

/** Hold every in-pod `buildctl build` open, resolving once the first starts. */
function holdInPodBuild(): Promise<void> {
  spawnState.hold = (file, args) => file === 'kubectl' && args.includes('build')
  return new Promise<void>((resolve) => { spawnState.onHold = resolve })
}

beforeEach(async () => {
  vi.clearAllMocks()
  _clearBuildCoordinatorForTests()
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
  // Only the builder image is in the registry, recorded as install pushed
  // it, so `ensureBuilderImage` resolves without building.
  fakeRegistry.install()
  fakeRegistry.mirror(await resolveBuilderImageTag())
  mockEnsureMainRegistry.mockResolvedValue(undefined)
  execState.calls.length = 0
  execState.error = null
  fakeCluster.seed({
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: 'yaac-registry-grant-key', namespace: 'yaac-registry-keys' },
    data: { 'key.pem': Buffer.from(GRANT_KEY.export({ type: 'pkcs8', format: 'pem' })).toString('base64') },
  })
  _resetRegistryGrantKeyForTests()
  // The proxy, which builder pods resolve names through, as its bootstrap
  // (a sibling feature, faked here) leaves it.
  ensureProxy = vi.spyOn(proxyClient, 'ensureRunning').mockResolvedValue()
  fakeCluster.seed({
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: 'yaac-proxy', namespace: k8sNamespace() },
    spec: { clusterIP: PROXY_IP },
  })
  resetProxyClusterIpCache()
})

afterEach(async () => {
  _clearBuildCoordinatorForTests()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('resolveChain', () => {
  it('stacks project and user layers on the trusted chain, or a standalone project alone', async () => {
    const { base, tools } = await resolveTrustedLayers()
    const layered = await resolveChain(spec(await source('project'), await source('user')))
    expect(layered.layers.map((l) => l.name)).toEqual(['base', 'tools', 'project', 'user'])
    const [, , project, user] = layered.layers
    expect(layered.layers.slice(0, 2)).toEqual([{ name: 'base', tag: base.tag }, { name: 'tools', tag: tools.tag, parentTag: base.tag }])
    expect(project.tag.startsWith(`yaac-proj-${PROJ}:`)).toBe(true)
    expect(project.parentTag).toBe(tools.tag)
    expect(user.tag.startsWith(`yaac-user-${PROJ}:`)).toBe(true)
    expect(user.parentTag).toBe(project.tag)
    expect(layered.finalTag).toBe(user.tag)

    const standalone = await resolveChain(spec(await source('project', 'FROM ubuntu\n')))
    expect(standalone.layers.map((l) => [l.name, l.parentTag])).toEqual([['project', undefined]])
  })
})

describe('missingImageLayers', () => {
  it('names the absent untrusted layers, and checks each tag once a run', async () => {
    const chain = await resolveChain(spec(await source('project'), await source('user')))
    const [base, tools, project, user] = chain.layers
    fakeRegistry.tags.add(base.tag).add(tools.tag).add(project.tag)
    expect(await missingImageLayers(chain)).toEqual(['user'])

    // Content-hash tags never change, so a present tag is not re-checked;
    // an absent one is, since a build may have pushed it since.
    fakeRegistry.lookups.length = 0
    expect(await missingImageLayers(chain)).toEqual(['user'])
    expect(fakeRegistry.lookups).toEqual([user.tag])
  })

  it('refuses a missing yaac-shipped layer, naming what builds it', async () => {
    const chain = await resolveChain(spec(await source('project')))
    // The server cannot build base/tools, so the error names the command
    // that does.
    await expect(missingImageLayers(chain)).rejects.toThrow(/base image yaac-base:\S+ is missing.*yaac cluster install/s)
    vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', '1')
    await expect(missingImageLayers(chain)).rejects.toThrow(/Restart the test run/)
  })

  it('fails, rather than counting a layer missing, when the registry does not answer for it', async () => {
    const chain = await resolveChain(spec(await source('project')))
    const [base, tools, project] = chain.layers
    fakeRegistry.tags.add(base.tag).add(tools.tag)
    // A 500 for the project layer's manifest alone.
    const registryFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) =>
      String(input).endsWith(`/manifests/${project.tag.split(':')[1]}`)
        ? Promise.resolve(new Response(null, { status: 500 }))
        : registryFetch(input, init))
    await expect(missingImageLayers(chain))
      .rejects.toThrow(`the registry did not say whether it has ${project.tag}`)

    // An unreachable registry is not a missing install either.
    _clearBuildCoordinatorForTests()
    fakeRegistry.down = true
    await expect(missingImageLayers(chain))
      .rejects.toThrow(`the registry did not say whether it has ${base.tag}`)
  })
})

describe('buildImageLayers', () => {
  it('builds an untrusted layer with buildkitd in a gvisor builder pod', async () => {
    // The whole builder-pod path: egress registration, manifest, daemon
    // start, context tar, Dockerfile with the normalize step, policy,
    // grant, one buildctl build that pushes, teardown.
    const chainSpec = await layeredProject({
      'keep.txt': 'k',
      'skipped/file.txt': 's',
      '.containerignore': 'skipped\n',
    })
    const chain = await resolveChain(chainSpec)
    const tools = chain.layers[1]
    const project = chain.layers[2]
    holdInPodBuild().then(() => {
      held[0].log('#5 [1/2] FROM ubuntu')
      held[0].close(0)
    }, () => {})
    const { req, seen } = request(chainSpec, ['project'])

    expect(await buildImageLayers(req)).toEqual({ ok: true, blockedHosts: [] })
    expect(seen.starts).toEqual(['project'])
    expect(seen.lines).toContain('project: #5 [1/2] FROM ubuntu')
    // The pushed tag is remembered, so the chain needs nothing now.
    expect(await missingImageLayers(chain)).toEqual([])

    expect(mockEnsureMainRegistry).toHaveBeenCalled()
    // The proxy is brought up first: a server that has launched no
    // workspace has none.
    expect(ensureProxy).toHaveBeenCalled()
    expect(appliedKinds()).toEqual(expect.arrayContaining([
      'ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding', 'NetworkPolicy', 'ConfigMap', 'Pod',
    ]))
    // The proxy knows the build before its pod dials: by build id, with
    // the project's allowed hosts and no owner.
    expect(appliedKinds().indexOf('ConfigMap')).toBeLessThan(appliedKinds().indexOf('Pod'))
    const registration = appliedOfKind<{ metadata: { name: string; labels: Record<string, string> }; data: Record<string, string> }>('ConfigMap')
    expect(registration.metadata.labels['yaac.build-id']).toBe(EGRESS_ID)
    expect(JSON.parse(registration.data['registration.json'])).toEqual({
      rules: [], allowedHosts: ['deb.debian.org'], projectId: PROJ, owner: 'none',
    })

    const pod = appliedOfKind<PodManifest>('Pod')
    expect(pod.metadata.name).toMatch(/^yaac-builder-[0-9a-f]{8}-[0-9a-f]{4}$/)
    expect(pod.metadata.namespace).toBe(k8sNamespace())
    expect(pod.metadata.labels).toEqual({
      'yaac.install-id': installId(),
      'yaac.role': 'builder',
      'yaac.project-id': PROJ,
      'yaac.build-id': EGRESS_ID,
    })
    expect(pod.spec.runtimeClassName).toBe('gvisor')
    // Outranks workspaces for eviction, but never preempts a running one.
    expect(pod.spec.priorityClassName).toBe('yaac-builder')
    expect(pod.spec.restartPolicy).toBe('Never')
    expect(pod.spec.activeDeadlineSeconds).toBe(BUILDER_ACTIVE_DEADLINE_SECONDS)
    expect(pod.spec.automountServiceAccountToken).toBe(false)
    expect(pod.spec.enableServiceLinks).toBe(false)
    expect(pod.spec.securityContext.seccompProfile.type).toBe('RuntimeDefault')
    // Names resolve through the proxy's DNS stub, which knows the registry.
    expect(pod.spec.dnsPolicy).toBe('None')
    expect(pod.spec.dnsConfig).toEqual({ nameservers: [PROXY_IP] })
    const container = pod.spec.containers[0]
    expect(container.resources.limits.memory).toBe(String(BUILDER_MEMORY_LIMIT_BYTES))
    // An explicit request well under the limit; Kubernetes would otherwise
    // default the request to the full limit.
    expect(container.resources.requests).toEqual({
      cpu: `${BUILDER_CPU_REQUEST_MILLIS}m`,
      memory: String(BUILDER_MEMORY_REQUEST_BYTES),
    })
    expect(BUILDER_MEMORY_REQUEST_BYTES).toBeLessThan(BUILDER_MEMORY_LIMIT_BYTES)
    // buildkitd is the entrypoint, its RUN steps sharing the pod's network.
    expect(container.command.join(' ')).toContain('exec buildkitd --config /etc/buildkit/buildkitd.toml --oci-worker-net=host')
    const env = Object.fromEntries(container.env.map((e) => [e.name, e.value]))
    // Gateway frontends off; the registry's pod port over plain HTTP.
    expect(env.BUILDKITD_CONFIG).toContain('[frontend."gateway.v0"]\n  enabled = false')
    expect(env.BUILDKITD_CONFIG).toContain(`[registry."${POD_HOST}"]\n  http = true`)
    expect(env.BUILDKITD_CONFIG).toContain('gc = false')
    // No cap on a step's log, so the build page gets all of it.
    expect(env.BUILDKIT_STEP_LOG_MAX_SPEED).toBe('-1')
    // The builder image by the digest install recorded, never its tag or
    // a user-customizable image.
    const builderTag = await resolveBuilderImageTag()
    expect(container.image)
      .toBe(`${CLUSTER_HOST}/${builderTag.slice(0, builderTag.indexOf(':'))}@${fakeRegistry.digestOf(builderTag)}`)
    expect(container.imagePullPolicy).toBe('IfNotPresent')
    expect(container.securityContext.capabilities.add).toContain('SETFCAP')
    // State on a gVisor tmpfs emptyDir.
    expect(pod.metadata.annotations['dev.gvisor.spec.mount.buildkit-state.type']).toBe('bind')
    expect(pod.metadata.annotations['dev.gvisor.spec.mount.buildkit-state.options'])
      .toBe(`rw,size=${BUILDER_STATE_TMPFS_BYTES}`)
    expect(pod.spec.volumes).toEqual([{
      name: 'buildkit-state',
      emptyDir: { sizeLimit: String(BUILDER_STATE_SIZELIMIT_BYTES) },
    }])
    expect(container.volumeMounts).toEqual([{ name: 'buildkit-state', mountPath: '/var/lib/buildkit' }])

    const np = appliedOfKind<{
      spec: { podSelector: { matchLabels: Record<string, string> }; policyTypes: string[]; egress: unknown[] }
    }>('NetworkPolicy')
    expect(np.spec.podSelector.matchLabels).toEqual({ 'yaac.role': 'builder' })
    expect(np.spec.policyTypes).toEqual(['Egress'])
    expect(np.spec.egress).toEqual((buildBuilderEgressNpManifest(['10.89.0.7/32']) as { spec: { egress: unknown } }).spec.egress)

    // Daemon wait, context, Dockerfile, policy, grant, build: in order.
    const remote = remoteCommands()
    const execs = spawned.filter((x) => x.file === 'kubectl')
    expect(remote).toHaveLength(6)
    expect(remote[0][2]).toContain('buildctl debug workers')
    expect(remote[1][2]).toContain(`tar -xf - -C ${BUILDER_CONTEXT_DIR}`)
    // The Dockerfile as built ends with the normalize step.
    expect(remote[2][2]).toContain(`cat > ${BUILDER_DOCKERFILE_DIR}/Dockerfile`)
    expect(execs[2].stdin).toBe(`${LAYERED_DOCKERFILE}\n${NORMALIZE_STEP}`)
    // Every image on the registry is denied but the parent.
    const policy = JSON.parse(execs[3].stdin) as { rules: Array<{ action: string; selector: { identifier: string } }> }
    expect(policy.rules.map((r) => `${r.action} ${r.selector.identifier}`)).toEqual([
      `DENY docker-image://${CLUSTER_HOST}/*`,
      `DENY docker-image://${POD_HOST}/*`,
      `ALLOW docker-image://${POD_HOST}/${tools.tag}*`,
    ])
    // The grant arrives over stdin, not argv, and covers only the product's
    // repo and the project's cache repo.
    expect(remote[4][2]).toContain(`cat > ${BUILDER_AUTHFILE}`)
    expect(remote[4][2]).toMatch(/^umask 077/)
    const grant = grantScopeOf(execs[4].stdin)
    expect(grant?.repos).toEqual([`yaac-proj-${PROJ}`, `yaac-buildcache-${PROJ}`])
    // Valid for the pod's maximum lifetime, and not much longer.
    expect(grant!.expiry - Date.now() / 1000).toBeGreaterThan(BUILDER_ACTIVE_DEADLINE_SECONDS)
    expect(grant!.expiry - Date.now() / 1000).toBeLessThan(BUILDER_ACTIVE_DEADLINE_SECONDS + 120)
    expect(execs[4].args.join(' ')).not.toContain(execs[4].stdin)
    // One build: the parent from the pod port, the built-in frontend
    // whatever the file names, this layer's cache window, a zstd push.
    const build = remote[5]
    expect(build.slice(0, 2)).toEqual(['buildctl', 'build'])
    const args = build.join(' ')
    expect(args).toContain('--opt cmdline=dockerfile.v0')
    expect(args).toContain(`--opt build-arg:BASE_IMAGE=${POD_HOST}/${tools.tag}`)
    const cacheRef = `${POD_HOST}/yaac-buildcache-${PROJ}:project-${IMAGE}-${cacheBucket(PROJ, BUILD_CACHE_MAX_DAYS)}`
    expect(args).toContain(`--import-cache type=registry,ref=${cacheRef}`)
    expect(args).toContain(`--export-cache type=registry,ref=${cacheRef},mode=max,image-manifest=true`)
    expect(args).toContain(`--output type=image,name=${POD_HOST}/${project.tag},push=true,compression=zstd`)
    expect(args).toContain('--progress plain')

    // The context honors .containerignore exactly like contextHash().
    expect(tarLists[0]).toEqual(expect.arrayContaining(['keep.txt', '.containerignore']))
    expect(tarLists[0].some((f) => f.startsWith('skipped/'))).toBe(false)

    // The pod and its registration go with the build.
    expect(deleteCalls()).toEqual([pod.metadata.name])
    expect(fakeCluster.callsOf('delete', 'ConfigMap').map((c) => c.name)).toEqual([registration.metadata.name])
  })

  it('builds a standalone layer allowing no registry image, without its cache when asked', async () => {
    const chainSpec = spec(await source('project', 'FROM ubuntu\n'))
    const { req } = request(chainSpec, ['project'], { noCache: true })
    expect(await buildImageLayers(req)).toMatchObject({ ok: true })

    const execs = spawned.filter((x) => x.file === 'kubectl')
    const build = remoteCommands()[5].join(' ')
    expect(build).not.toContain('BASE_IMAGE')
    expect((JSON.parse(execs[3].stdin) as { rules: Array<{ action: string }> }).rules.map((r) => r.action))
      .toEqual(['DENY', 'DENY'])
    expect(execs[2].stdin).toMatch(/^FROM ubuntu\n/)
    // Rebuilt from scratch, though the result still seeds the cache.
    expect(build).toContain('--no-cache')
    expect(build).not.toContain('--import-cache')
    expect(build).toContain('--export-cache')
  })

  it('names the cache repo by the project id and its tag by layer and image, and moves to a new cache each window', async () => {
    // A project re-added under an old name must not hit the old cache, and
    // two images of one project must not overwrite each other's.
    const chainSpec = { ...await layeredProject(), projectId: PROJ_B }
    chainSpec.layers[0].cacheKey = 'other-image'
    const { req } = request(chainSpec, ['project'], { cacheMaxDays: 7 })
    await buildImageLayers(req)
    const build = remoteCommands()[5].join(' ')
    expect(build).toContain(`${POD_HOST}/yaac-buildcache-${PROJ_B}:project-other-image-${cacheBucket(PROJ_B, 7)}`)
    // Windows are cacheMaxDays long, offset per project.
    const day = 86_400_000
    const now = Date.UTC(2026, 10, 23)
    const buckets = Array.from({ length: BUILD_CACHE_MAX_DAYS + 1 }, (_, d) => cacheBucket(PROJ_B, BUILD_CACHE_MAX_DAYS, now + d * day))
    expect(new Set(buckets).size).toBe(2)
    expect(buckets.filter((b) => b === buckets[0]).length).toBeLessThanOrEqual(BUILD_CACHE_MAX_DAYS)
  })

  it('reuses one builder pod across the project and user layers and deletes it once', async () => {
    const { tools } = await resolveTrustedLayers()
    fakeRegistry.tags.add(tools.tag)
    const chainSpec = spec(await source('project'), await source('user'))
    const { req, seen } = request(chainSpec, ['project', 'user'])
    expect(await buildImageLayers(req)).toMatchObject({ ok: true })

    expect(seen.starts).toEqual(['project', 'user'])
    expect(appliedKinds().filter((k) => k === 'Pod')).toHaveLength(1)
    expect(deleteCalls()).toHaveLength(1)
    // A shared pod gets a fresh grant per layer, for that layer's repo and,
    // for the user layer, the project layer it reads as its parent.
    const grants = spawned
      .filter((s) => s.file === 'kubectl' && s.args.at(-1)?.includes(`cat > ${BUILDER_AUTHFILE}`))
      .map((s) => grantScopeOf(s.stdin)?.repos)
    expect(grants).toEqual([
      [`yaac-proj-${PROJ}`, `yaac-buildcache-${PROJ}`],
      [`yaac-user-${PROJ}`, `yaac-buildcache-${PROJ}`, `yaac-proj-${PROJ}`],
    ])
  })

  it('reports a failed layer, and leaves it missing for the next build', async () => {
    const chainSpec = await layeredProject()
    spawnState.codeFor = (file, args) => (file === 'kubectl' && args.includes('build') ? 1 : undefined)
    const { req } = request(chainSpec, ['project'])
    const failed = await buildImageLayers(req)
    expect(failed).toMatchObject({ ok: false, failedLayer: 'project', blockedHosts: [] })
    expect(failed.error).toMatch(/exit(ed with)? code 1/)
    expect(deleteCalls()).toHaveLength(1)
    expect(await missingImageLayers(await resolveChain(chainSpec))).toEqual(['project'])
    // A layer the chain does not have is refused before any pod.
    fakeCluster.calls = []
    const refused = await buildImageLayers(request(chainSpec, ['base']).req)
    expect(refused).toMatchObject({ ok: false, failedLayer: 'base' })
    expect(refused.error).toMatch(/no untrusted base layer/)
    expect(appliedKinds()).not.toContain('Pod')
  })

  it('stops on abort, deleting the pod under the build', async () => {
    const started = holdInPodBuild()
    const abort = new AbortController()
    const { req } = request(await layeredProject(), ['project'], { signal: abort.signal })
    const outcome = buildImageLayers(req)
    await started
    abort.abort()
    await vi.waitFor(() => { expect(deleteCalls()).toHaveLength(1) })
    // kubectl exec ends when its pod goes.
    held[0].close(137)
    expect(await outcome).toMatchObject({ ok: false, error: 'cancelled', failedLayer: 'project' })
  })

  it('starts nothing for a request aborted before it is called', async () => {
    const abort = new AbortController()
    abort.abort()
    const { req, seen } = request(await layeredProject(), ['project'], { signal: abort.signal })
    expect(await buildImageLayers(req)).toEqual({
      ok: false, error: 'cancelled', failedLayer: 'project', blockedHosts: [],
    })
    expect(seen.starts).toEqual([])
    expect(appliedKinds()).not.toContain('Pod')
  })

  it('builds no further layer once aborted between layers', async () => {
    const { tools } = await resolveTrustedLayers()
    fakeRegistry.tags.add(tools.tag)
    const started = holdInPodBuild()
    const abort = new AbortController()
    const { req, seen } = request(spec(await source('project'), await source('user')), ['project', 'user'], {
      signal: abort.signal,
    })
    const outcome = buildImageLayers(req)
    // The project layer's build succeeds, then the request is aborted.
    await started
    held[0].close(0)
    abort.abort()

    expect(await outcome).toMatchObject({ ok: false, error: 'cancelled', failedLayer: 'user' })
    expect(seen.starts).toEqual(['project'])
    expect(remoteCommands().filter((c) => c[1] === 'build')).toHaveLength(1)
    expect(appliedKinds().filter((k) => k === 'Pod')).toHaveLength(1)
    expect(deleteCalls()).toHaveLength(1)
  })

  it('fails closed when the ValidatingAdmissionPolicy API is unavailable', async () => {
    fakeCluster.removeKind('ValidatingAdmissionPolicy')
    const { req } = request(await layeredProject(), ['project'])
    expect((await buildImageLayers(req)).error).toMatch(/ValidatingAdmissionPolicy/)
    // Without the guard the builder label could be forged, so no pod.
    expect(appliedKinds()).not.toContain('Pod')
  })

  it('maps an unreachable cluster to a `yaac cluster check` pointer', async () => {
    const chainSpec = await layeredProject()
    fakeCluster.unreachable = new Error('no cluster')
    expect((await buildImageLayers(request(chainSpec, ['project']).req)).error).toMatch(/yaac cluster check/)
  })

  it('explains a Ready timeout with whatever the pod status accounts for', async () => {
    // A bare `kubectl wait` timeout looks like a broken build, but an
    // unschedulable pod is far more likely.
    const chainSpec = await layeredProject()
    const errorOf = async (): Promise<string | undefined> => (await buildImageLayers(request(chainSpec, ['project']).req)).error
    execState.error = new Error('timed out')
    podStatus({
      conditions: [{
        type: 'PodScheduled', status: 'False', reason: 'Unschedulable',
        message: '0/1 nodes are available: 1 Insufficient memory.',
      }],
    })
    expect(await errorOf()).toMatch(/not scheduled \(Unschedulable\): 0\/1 nodes are available/)
    // The pod is deleted even though setup failed.
    expect(deleteCalls().length).toBeGreaterThan(0)

    // A container stuck pulling is named the same way.
    podStatus({
      conditions: [{ type: 'PodScheduled', status: 'True' }],
      containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }],
    })
    expect(await errorOf()).toMatch(/container waiting \(ImagePullBackOff\)/)

    // An uninformative status leaves the bare timeout.
    podStatus({})
    expect(await errorOf()).toMatch(/^timed out/)
  })

  it('kills an in-pod build only once it stops producing output', async () => {
    // The timeout is on idle time: a slow build that keeps logging
    // survives, and only silence ends it.
    const reachedBuild = holdInPodBuild()
    const { req } = request(await layeredProject(), ['project'])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const build = buildImageLayers(req)
    const settled = vi.fn()
    void build.then(settled)

    // The steps before the build do real filesystem IO, so wait for them.
    await reachedBuild
    expect(held).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(BUILDER_BUILD_IDLE_TIMEOUT_MS - 1_000)
    held[0].log('#7 [2/5] RUN cargo build --release')
    await vi.advanceTimersByTimeAsync(BUILDER_BUILD_IDLE_TIMEOUT_MS - 1_000)
    expect(settled).not.toHaveBeenCalled()
    expect(held[0].signals).toEqual([])

    await vi.advanceTimersByTimeAsync(5_000)
    expect((await build).error).toMatch(/builder exec \[buildctl build .*\] produced no output for 600s/)
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
    const { req } = request(await layeredProject(), ['project'])
    expect((await buildImageLayers(req)).error).toMatch(/exited with code 137[\s\S]*stopped at the whole-pod deadline/)
  })

  it('rejects an oversized context', async () => {
    const chainSpec = await layeredProject()
    // Sparse file: st_size crosses the cap without touching the disk.
    const fh = await fs.open(path.join(chainSpec.layers[0].contextDir, 'big.bin'), 'w')
    await fh.truncate(BUILDER_CONTEXT_MAX_BYTES + 1)
    await fh.close()
    expect((await buildImageLayers(request(chainSpec, ['project']).req)).error).toMatch(/\.containerignore/)
  })
})

describe('imageRef', () => {
  it('names a tag on the registry the node pulls from', () => {
    expect(imageRef('yaac-proj-x:1')).toBe(`${CLUSTER_HOST}/yaac-proj-x:1`)
  })
})
