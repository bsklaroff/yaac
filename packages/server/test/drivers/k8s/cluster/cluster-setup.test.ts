import crypto from 'node:crypto'
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  // The REAL predicate: these suites drive the absent-vs-unevaluable
  // split, which is the whole point of the adoption gate's reads.
  isKubectlAbsentError: (await importOriginal<
    { isKubectlAbsentError: (err: unknown) => boolean }
  >()).isKubectlAbsentError,
  kubectlErrorSummary: (await importOriginal<
    { kubectlErrorSummary: (err: unknown) => string }
  >()).kubectlErrorSummary,
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

import { ClusterSetupError, runClusterSetup } from '#drivers/k8s/cluster'
// The deps shape is part of the public interface (runClusterSetup takes one);
// CALICO_VERSION is a pinned setup value for the assertions.
import { CALICO_VERSION, type ClusterSetupDeps } from '#drivers/k8s/cluster/setup'
import { nodeIpBlocks, resetClusterCidrCache } from '#drivers/k8s/cluster/cluster-cidrs'
import { kubectlGetJson } from '#drivers/k8s/substrate/kubectl'
import { NODE_KUBELET_HOUSEKEEPING_INTERVAL } from '#drivers/k8s/cluster/check'

afterEach(() => {
  vi.unstubAllEnvs()
})

type RunMock = ReturnType<typeof vi.fn<
  (file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string }>
>>

type StreamMock = ReturnType<typeof vi.fn<
  (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; input?: string }) => Promise<void>
>>

/**
 * deps.run responses for a healthy linux host: podman 6 paired with a
 * post-#4203 kind dev build (the skew diagnosis leaves dev builds to the
 * functional probe, which succeeds here).
 */
function happyRun(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  if (file === 'podman' && args[0] === '--version') {
    return Promise.resolve({ stdout: 'podman version 6.0.0\n', stderr: '' })
  }
  if (file === 'kind' && args[0] === 'version') {
    return Promise.resolve({ stdout: 'kind v0.33.0-alpha.100+f1ec7694f59f57 go1.24.4 linux/arm64\n', stderr: '' })
  }
  if (file === 'kind' && args[0] === 'get' && args[1] === 'clusters') {
    return Promise.resolve({ stdout: '', stderr: '' })
  }
  if (file === 'kind' && args[0] === 'get' && args[1] === 'nodes') {
    return Promise.resolve({ stdout: 'yaac-control-plane\n', stderr: '' })
  }
  // The gVisor install probes the node arch before fetching binaries.
  if (file === 'podman' && args[0] === 'exec' && args.includes('uname')) {
    return Promise.resolve({ stdout: 'aarch64\n', stderr: '' })
  }
  return Promise.resolve({ stdout: '', stderr: '' })
}

/** Stand-in Calico manifest and its real checksum, so the pin verifies. */
const FAKE_CALICO_MANIFEST = 'kind: DaemonSet\nmetadata:\n  name: calico-node\n'
const FAKE_CALICO_SHA256 = crypto.createHash('sha256')
  .update(FAKE_CALICO_MANIFEST, 'utf8').digest('hex')

/**
 * Stand-in kind config with the shape the renderer requires: cluster-scoped
 * wiring first (kind applies it to every node), then a `nodes:` list as the
 * last section holding exactly one control-plane entry with the $HOME
 * extraMount — the entry `--nodes` copies into workers.
 */
const FAKE_KIND_CONFIG = [
  'kind: Cluster',
  'containerdConfigPatches:',
  '- |-',
  '  [plugins."io.containerd.grpc.v1.cri".registry]',
  '    config_path = "/etc/containerd/certs.d"',
  'nodes:',
  '- role: control-plane',
  '  extraMounts:',
  '  - hostPath: $HOME',
  '    containerPath: $HOME',
  '',
].join('\n')

/**
 * readTextFile over the three files setup reads: the Calico checksum pin,
 * the cached Calico manifest, and the kind config.
 */
function fakeCalicoReadTextFile(p: string): Promise<string | null> {
  if (p.endsWith('.sha256')) return Promise.resolve(`${FAKE_CALICO_SHA256}  calico.yaml\n`)
  if (p.includes('calico')) return Promise.resolve(FAKE_CALICO_MANIFEST)
  return Promise.resolve(FAKE_KIND_CONFIG)
}

function makeDeps(
  overrides: Omit<Partial<ClusterSetupDeps>, 'run' | 'runStreaming'> & {
    run?: RunMock
    runStreaming?: StreamMock
  } = {},
): ClusterSetupDeps & { run: RunMock; runStreaming: StreamMock } {
  const run = overrides.run ?? (vi.fn(happyRun) as RunMock)
  const runStreaming = overrides.runStreaming
    ?? (vi.fn(() => Promise.resolve()) as StreamMock)
  return {
    run: run as unknown as ClusterSetupDeps['run'],
    runStreaming,
    log: overrides.log ?? vi.fn(),
    confirm: overrides.confirm ?? vi.fn().mockResolvedValue(false),
    ensureRegistry: overrides.ensureRegistry
      ?? vi.fn().mockResolvedValue('yaac-registry.yaac.svc.cluster.local:5000'),
    ensureBuilderGuard: overrides.ensureBuilderGuard ?? vi.fn().mockResolvedValue(undefined),
    ensureNetd: overrides.ensureNetd ?? vi.fn().mockResolvedValue(undefined),
    ensureGvisorRuntime: overrides.ensureGvisorRuntime ?? vi.fn().mockResolvedValue(undefined),
    ensurePriorityClasses: overrides.ensurePriorityClasses ?? vi.fn().mockResolvedValue(undefined),
    check: overrides.check ?? vi.fn().mockResolvedValue({ ok: true, results: [] }),
    platform: overrides.platform ?? 'linux',
    homedir: overrides.homedir ?? ((): string => '/home/tester'),
    totalmem: overrides.totalmem ?? ((): number => 64 * 1024 ** 3),
    cpuCount: overrides.cpuCount ?? ((): number => 10),
    // Setup reads the kind config (with $HOME to substitute) and, for
    // Calico, the committed checksum plus a manifest that matches it —
    // here the cached copy, so no download is attempted.
    readTextFile: overrides.readTextFile ?? vi.fn(fakeCalicoReadTextFile),
    writeTextFile: overrides.writeTextFile ?? vi.fn().mockResolvedValue(undefined),
    fetchText: overrides.fetchText ?? vi.fn().mockResolvedValue(FAKE_CALICO_MANIFEST),
    fileExists: overrides.fileExists ?? vi.fn().mockResolvedValue(false),
    listDir: overrides.listDir ?? vi.fn().mockResolvedValue([]),
  } as ClusterSetupDeps & { run: RunMock; runStreaming: StreamMock }
}

// ---------------------------------------------------------------------------
// --adopt-cni fixtures
// ---------------------------------------------------------------------------

/** A fully rolled-out calico-node DaemonSet in the iptables dataplane. */
const HEALTHY_CALICO_DS = {
  status: { numberReady: 1, desiredNumberScheduled: 1 },
  spec: { template: { spec: { containers: [{ name: 'calico-node', env: [] }] } } },
}

/** Real kind-node `ip -4 route show`, as netd's exec returns it. */
const ADOPT_ROUTES = [
  'default via 10.89.0.1 dev eth0',
  'blackhole 10.244.169.192/26 proto 80',
  '10.244.169.193 dev calibb6b64b7901 scope link',
  '10.244.169.197 dev calia132c78e002 scope link',
].join('\n')

/** The single-node fleet the fixtures describe, unless a case says otherwise. */
const ADOPT_NODES = ['yaac-control-plane']

interface AdoptFacts {
  /** calico-node DaemonSet; `null` means the cluster has none. */
  calico?: object | null
  /** FelixConfiguration objects; omitted means none is served (Felix defaults). */
  felix?: object[]
  /** kube-proxy pods, keyed by the label that finds them (default `k8s-app`). */
  kubeProxyPods?: Array<{ spec?: { nodeName?: string }; status?: { phase?: string } }>
  /** Which label selector answers — GKE/AKS stamp `component`, not `k8s-app`. */
  kubeProxyLabel?: 'k8s-app' | 'component'
  /** `false` removes the system-node-critical PriorityClass. */
  systemNodeCritical?: boolean
  /** Node names, and whether each is schedulable (taint-free / uncordoned). */
  nodes?: Array<{ name: string; schedulable?: boolean; taint?: string }>
  /** `scheduling.tolerations` on the gvisor RuntimeClass. */
  tolerations?: Array<Record<string, string>>
  /** netd pods to probe; omitted means one Running per node. */
  netdPods?: Array<{ name: string; node: string; phase?: string }>
  /** `ip -4 route show` per netd pod name; a string applies to all. */
  routes?: string | null | Record<string, string | null>
  /** `false` takes kind off PATH — adopt mode must not need it. */
  kind?: boolean
  /** A kubectl read that fails for a reason that is NOT genuine absence. */
  denied?: 'felix' | 'kube-proxy' | 'nodes' | 'calico'
}

/**
 * deps.run answering every kubectl read the `--adopt-cni` gate makes, on
 * top of the healthy-host responses. Absence is modelled as kubectl's own
 * NotFound wording — which is what a cluster serving no Calico CRD actually
 * says, and what the gate must distinguish from a read it could not make.
 */
function adoptRun(facts: AdoptFacts = {}): RunMock {
  const json = (v: unknown): Promise<{ stdout: string; stderr: string }> =>
    Promise.resolve({ stdout: JSON.stringify(v), stderr: '' })
  const absent = (): Promise<never> => Promise.reject(new Error('Error from server (NotFound)'))
  const denied = (): Promise<never> => Promise.reject(Object.assign(new Error('exit 1'), {
    stderr: 'Error from server (Forbidden): pods is forbidden: User "x" cannot list resource',
  }))
  const nodes: NonNullable<AdoptFacts['nodes']> =
    facts.nodes ?? ADOPT_NODES.map((name) => ({ name }))
  const netdPods: NonNullable<AdoptFacts['netdPods']> = facts.netdPods
    ?? nodes.map((n, i) => ({ name: `yaac-netd-${i}`, node: n.name }))

  return vi.fn((file: string, args: string[]) => {
    if (file === 'kind' && facts.kind === false) return Promise.reject(new Error('ENOENT'))
    if (file === 'kubectl' && args[0] === 'get') {
      if (args[1] === 'daemonset' && args[2] === 'calico-node') {
        if (facts.denied === 'calico') return denied()
        return facts.calico === null ? absent() : json(facts.calico ?? HEALTHY_CALICO_DS)
      }
      if (args[1]?.startsWith('felixconfigurations')) {
        if (facts.denied === 'felix') return denied()
        return facts.felix === undefined ? absent() : json({ items: facts.felix })
      }
      if (args[1] === 'pods' && args.some((a) => a.includes('kube-proxy'))) {
        if (facts.denied === 'kube-proxy') return denied()
        const label = facts.kubeProxyLabel ?? 'k8s-app'
        const asked = args.includes(`${label}=kube-proxy`)
        return json({
          items: asked
            ? facts.kubeProxyPods
              ?? nodes.map((n) => ({ spec: { nodeName: n.name }, status: { phase: 'Running' } }))
            : [],
        })
      }
      if (args[1] === 'pods' && args.includes('app=yaac-netd')) {
        return json({
          items: netdPods.map((p) => ({
            metadata: { name: p.name },
            spec: { nodeName: p.node },
            status: { phase: p.phase ?? 'Running' },
          })),
        })
      }
      if (args[1] === 'nodes') {
        if (facts.denied === 'nodes') return denied()
        return json({
          items: nodes.map((n) => ({
            metadata: { name: n.name },
            spec: n.taint
              ? { taints: [{ key: n.taint, effect: 'NoSchedule' }] }
              : n.schedulable === false
                ? { taints: [{ key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' }] }
                : {},
          })),
        })
      }
      if (args[1] === 'runtimeclass') {
        return json({ scheduling: { tolerations: facts.tolerations ?? [] } })
      }
      if (args[1] === 'priorityclass') {
        return facts.systemNodeCritical === false ? absent() : json({ metadata: { name: args[2] } })
      }
    }
    if (file === 'kubectl' && args[0] === 'exec') {
      const pod = args[1]
      const routes = typeof facts.routes === 'object' && facts.routes !== null
        ? facts.routes[pod]
        : facts.routes
      return routes === null
        ? Promise.reject(new Error('unable to upgrade connection: container not found'))
        : Promise.resolve({ stdout: routes ?? ADOPT_ROUTES, stderr: '' })
    }
    return happyRun(file, args)
  }) as RunMock
}

/**
 * The pod-CIDR sources `clusterPodCidrs`/the gate read through
 * `kubectlGetJson` (a different process boundary than deps.run).
 */
function stageAdoptCidrs(opts: { pools?: string[]; nodeCidrs?: string[] } = {}): void {
  resetClusterCidrCache()
  const impl = (args: string[]): Promise<unknown> => {
    if (args[1]?.startsWith('ippools')) {
      return Promise.resolve({
        items: (opts.pools ?? ['192.168.0.0/16']).map((cidr) => ({ spec: { cidr } })),
      })
    }
    if (args[1] === 'nodes') {
      return Promise.resolve({
        items: (opts.nodeCidrs ?? ['10.244.0.0/24']).map((podCIDR) => ({ spec: { podCIDR } })),
      })
    }
    return Promise.resolve(null)
  }
  vi.mocked(kubectlGetJson).mockImplementation(impl as never)
}

/** Every line the setup logged, joined — the gate's record lives here. */
function logged(deps: { log: unknown }): string {
  return vi.mocked(deps.log as (m: string) => void).mock.calls.map(([m]) => m).join('\n')
}

/** readTextFile serving the committed pin, plus whatever else a case wants. */
function calicoReads(rest: (p: string) => string | null) {
  return vi.fn((p: string) => Promise.resolve(
    p.endsWith('.sha256')
      ? `${FAKE_CALICO_SHA256}  calico.yaml\n`
      : p.includes('calico')
        ? rest(p)
        : FAKE_KIND_CONFIG,
  ))
}

describe('runClusterSetup', () => {
  it('runs the full setup in order on a healthy linux host', async () => {
    const deps = makeDeps()
    const ok = await runClusterSetup({}, deps)

    expect(ok).toBe(true)
    // The registry is an in-cluster Deployment, so it is stood up AFTER
    // the cluster exists, not before it.
    expect(deps.ensureRegistry).toHaveBeenCalledOnce()
    // Admission guard reserving yaac.role=builder for the sandboxed builders.
    expect(deps.ensureBuilderGuard).toHaveBeenCalledOnce()
    // netd deployed before the check, so the datapath gate has something
    // to verify on a freshly-created cluster.
    expect(deps.ensureNetd).toHaveBeenCalledOnce()
    // Cluster-scoped objects the manifest builders name — a pod naming a
    // missing PriorityClass is rejected, so setup installs them.
    expect(deps.ensurePriorityClasses).toHaveBeenCalledOnce()

    // Cluster recreated: delete (best-effort) then create from the bundled
    // config with $HOME substituted, under the podman provider.
    const runCalls = deps.run.mock.calls
    const deleteCall = runCalls.find(([f, a]) => f === 'kind' && a[0] === 'delete')
    expect(deleteCall?.[1]).toEqual(['delete', 'cluster', '--name', 'yaac'])
    const createCall = deps.runStreaming.mock.calls.find(([f, a]) => f === 'kind' && a[0] === 'create')
    expect(createCall).toBeDefined()
    expect(createCall?.[2]?.input).toContain('/home/tester')
    expect(createCall?.[2]?.input).not.toContain('$HOME')
    expect(createCall?.[2]?.env?.KIND_EXPERIMENTAL_PROVIDER).toBe('podman')

    // Calico applied from the verified manifest, then rolled out and the
    // node waited Ready (nodes cannot go Ready before the CNI is up).
    const calicoApply = deps.runStreaming.mock.calls
      .find(([f, a]) => f === 'kubectl' && a.includes('apply') && a.includes('-f'))
    expect(calicoApply?.[2]?.input).toContain('calico-node')
    expect(runCalls.some(([f, a]) =>
      f === 'kubectl' && a.includes('rollout') && a.includes('daemonset/calico-node'))).toBe(true)
    expect(runCalls.some(([f, a]) => f === 'kubectl' && a.includes('--for=condition=Ready'))).toBe(true)

    // Node fixups: TasksMax/sysctls via podman exec, then the node
    // container's pids ceiling. NO registry wiring — neither the kind
    // network join nor a hosts.toml write survives here; the registries
    // write their own from in-cluster pods.
    const execCmds = runCalls
      .filter(([f, a]) => f === 'podman' && a[0] === 'exec')
      .map(([, a]) => a[a.length - 1])
    expect(execCmds.some((c) => c.includes('hosts.toml'))).toBe(false)
    expect(execCmds.some((c) => c.includes('DefaultTasksMax=infinity'))).toBe(true)
    expect(execCmds.some((c) => c.includes('min_free_kbytes'))).toBe(true)
    // kubelet housekeeping interval: idempotent kubeadm-flags.env edit,
    // restarting kubelet only when the flag was absent.
    expect(execCmds.some((c) =>
      c.includes(`--housekeeping-interval=${NODE_KUBELET_HOUSEKEEPING_INTERVAL}`)
      && c.includes('/var/lib/kubelet/kubeadm-flags.env')
      && c.includes('systemctl restart kubelet'))).toBe(true)
    expect(runCalls.some(([f, a]) => f === 'podman' && a[0] === 'update' && a.includes('32768'))).toBe(true)
    expect(runCalls.some(([f, a]) => f === 'podman' && a[0] === 'network')).toBe(false)

    // gVisor: an in-cluster installer DaemonSet, so setup itself never
    // touches a node for it — no podman exec, no host-side download.
    expect(deps.ensureGvisorRuntime).toHaveBeenCalledOnce()
    expect(runCalls.some(([f]) => f === 'sh')).toBe(false)
    expect(runCalls.some(([f, a]) => f === 'podman' && a[0] === 'cp')).toBe(false)
    expect(execCmds.some((c) => c.includes('runsc') || c.includes('restart containerd'))).toBe(false)
    // ...and it lands after the REGISTRY is stood up, since its image is
    // mirrored through it — the same dependency netd has. (The old anchor
    // was the kind-network join, which no longer exists: the registry is an
    // in-cluster Deployment, so there is no container to attach to a
    // podman network.)
    const gvisorOrder = vi.mocked(deps.ensureGvisorRuntime).mock.invocationCallOrder[0]
    const registryOrder = vi.mocked(deps.ensureRegistry).mock.invocationCallOrder[0]
    expect(gvisorOrder).toBeGreaterThan(registryOrder)

    expect(deps.check).toHaveBeenCalledOnce()
  })

  it('aborts when the PriorityClasses cannot be installed', async () => {
    // Unlike the registry Service and netd (both re-ensured lazily by the
    // server), a missing PriorityClass makes the apiserver REJECT every pod
    // that names one — and a rejected session pod hangs its Job instead of
    // failing it. So this one is not fail-soft.
    const deps = makeDeps({
      ensurePriorityClasses: vi.fn().mockRejectedValue(new Error('apiserver said no')),
    })
    await expect(runClusterSetup({}, deps)).rejects.toThrow('apiserver said no')
    expect(deps.check).not.toHaveBeenCalled()
  })

  it('returns false when the finishing cluster check fails', async () => {
    const deps = makeDeps({
      check: vi.fn().mockResolvedValue({
        ok: false,
        results: [{ name: 'probe', status: 'fail', detail: 'x' }],
      }),
    })
    await expect(runClusterSetup({}, deps)).resolves.toBe(false)
    // A generic failure gets the generic line and nothing more.
    expect(logged(deps)).not.toMatch(/Do not start sessions/)
  })

  it('spells out what a failed egress gate leaves behind, since the install stays', async () => {
    // Every mode installs BEFORE it verifies, so the exit code is the only
    // artifact of a failed check and nothing re-checks between explicit
    // `cluster check` runs. For the egress gate that means sessions whose
    // lockdown is applied but not ENFORCED — they work, and the proxy
    // allowlist silently covers only the ports the redirect steers. A red
    // line in a list is not enough for a containment weakening.
    const deps = makeDeps({
      check: vi.fn().mockResolvedValue({
        ok: false,
        results: [{ name: 'egress', status: 'fail', detail: 'reached the apiserver' }],
      }),
    })
    await expect(runClusterSetup({}, deps)).resolves.toBe(false)
    const log = logged(deps)
    expect(log).toMatch(/Do not start sessions until a re-run passes/)
    expect(log).toMatch(/advisory/)
  })

  it('honors YAAC_KIND_CLUSTER for every kind invocation', async () => {
    vi.stubEnv('YAAC_KIND_CLUSTER', 'yaac-alt')
    const deps = makeDeps()
    await runClusterSetup({}, deps)
    const kindCalls = deps.run.mock.calls.filter(([f]) => f === 'kind')
    expect(kindCalls.some(([, a]) => a.join(' ') === 'delete cluster --name yaac-alt')).toBe(true)
    expect(kindCalls.some(([, a]) => a.join(' ') === 'get nodes --name yaac-alt')).toBe(true)
  })

  it('renders one worker per extra --nodes, each carrying the home extraMount', async () => {
    const deps = makeDeps()
    await runClusterSetup({ nodes: 3 }, deps)

    const input = deps.runStreaming.mock.calls
      .find(([f, a]) => f === 'kind' && a[0] === 'create')?.[2]?.input ?? ''
    // One control plane, two workers — the workers are copies of the
    // control-plane entry, so every node gets the $HOME bind that keeps
    // hostPath resolving to the same bytes wherever a session lands.
    expect(input.match(/^- role: control-plane$/gm)).toHaveLength(1)
    expect(input.match(/^- role: worker$/gm)).toHaveLength(2)
    expect(input.match(/hostPath: \/home\/tester$/gm)).toHaveLength(3)
    expect(input).not.toContain('$HOME')
    // Cluster-scoped wiring is NOT duplicated: kind applies it to every node.
    expect(input.match(/config_path/g)).toHaveLength(1)
  })

  it('applies the container-side node fixups to every node of a multi-node cluster', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'kind' && args[0] === 'get' && args[1] === 'nodes') {
        return Promise.resolve({
          stdout: 'yaac-control-plane\nyaac-worker\nyaac-worker2\n', stderr: '',
        })
      }
      return happyRun(file, args)
    }) as RunMock
    const deps = makeDeps({ run })
    await runClusterSetup({ nodes: 3 }, deps)

    const allNodes = ['yaac-control-plane', 'yaac-worker', 'yaac-worker2']
    // The container-side fixups are per-node state: a node missing them
    // dies under subagent fan-out no matter what the other nodes have.
    const fixupWrites = run.mock.calls
      .filter(([f, a]) => f === 'podman' && a[0] === 'exec'
        && String(a[a.length - 1]).includes('DefaultTasksMax=infinity'))
      .map(([, a]) => a[1])
    expect(fixupWrites).toEqual(allNodes)
    // The per-node REGISTRY wiring is deliberately NOT in this loop: both
    // registries are in-cluster Services now, and their containerd
    // hosts.toml is written by one-shot pods that loop the live node list
    // themselves (pinned in main-registry.test.ts). Setup never execs a
    // node for it, so nothing here can go stale against a node added later.
    expect(run.mock.calls.some(([f, a]) => f === 'podman' && a[0] === 'exec'
      && String(a[a.length - 1]).includes('hosts.toml'))).toBe(false)
    // Same for the pids ceiling on the node container...
    expect(run.mock.calls
      .filter(([f, a]) => f === 'podman' && a[0] === 'update' && a.includes('32768'))
      .map(([, a]) => a[a.length - 1])).toEqual(allNodes)
    // The runsc install is deliberately NOT in this loop: it is a DaemonSet
    // that lands on every node itself (including nodes added later, which a
    // host-side loop over today's node list would never reach), so setup
    // applies it once. `cluster check`'s runsc-nodes gate is what verifies
    // it converged everywhere.
    expect(deps.ensureGvisorRuntime).toHaveBeenCalledOnce()
    expect(run.mock.calls.some(([f, a]) =>
      f === 'podman' && a[0] === 'cp' && String(a[2]).includes('/runsc'))).toBe(false)
  })

  it('rejects a --nodes value it cannot honor before touching the host', async () => {
    // The node count is decided at create time, so --repair has no way to
    // act on it.
    const repairDeps = makeDeps()
    await expect(runClusterSetup({ repair: true, nodes: 3 }, repairDeps))
      .rejects.toThrow(/cannot be combined with --repair/)
    expect(repairDeps.run).not.toHaveBeenCalled()

    // Out of range, non-integer, and non-numeric — the CLI hands the raw
    // text through, so the message quotes what was typed, not "NaN".
    for (const nodes of [0, 99, 2.5, 'three']) {
      const deps = makeDeps()
      const err = await runClusterSetup({ nodes }, deps).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ClusterSetupError)
      expect((err as Error).message).toContain('between 1 and 5')
      expect((err as Error).message).toContain(`"${nodes}"`)
      expect(deps.run).not.toHaveBeenCalled()
      expect(deps.ensureRegistry).not.toHaveBeenCalled()
    }
  })

  it('reports every missing binary at once', async () => {
    const run = vi.fn((file: string) => {
      if (file === 'podman' || file === 'kind' || file === 'kubectl') {
        return Promise.reject(new Error('ENOENT'))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const deps = makeDeps({ run })
    const err = await runClusterSetup({}, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    const msg = (err as Error).message
    expect(msg).toContain('Missing required tools')
    expect(msg).toContain('podman')
    expect(msg).toContain('kind')
    expect(msg).toContain('kubectl')
    // Nothing was mutated.
    expect(deps.ensureRegistry).not.toHaveBeenCalled()
    expect(deps.runStreaming).not.toHaveBeenCalled()
  })

  it('diagnoses the podman-6/kind-0.32 skew before touching anything', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'podman' && args[0] === '--version') {
        return Promise.resolve({ stdout: 'podman version 6.0.0\n', stderr: '' })
      }
      if (file === 'kind' && args[0] === 'version') {
        return Promise.resolve({ stdout: 'kind v0.32.0 go1.24.4 darwin/arm64\n', stderr: '' })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const deps = makeDeps({ run })
    const err = await runClusterSetup({}, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toContain('yaac-kind')
    expect(deps.ensureRegistry).not.toHaveBeenCalled()
  })

  it('surfaces a functional preflight failure with the kind stderr', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'podman' && args[0] === '--version') {
        return Promise.resolve({ stdout: 'podman version 5.8.1\n', stderr: '' })
      }
      if (file === 'kind' && args[0] === 'version') {
        return Promise.resolve({ stdout: 'kind v0.32.0 go1.24.4 linux/arm64\n', stderr: '' })
      }
      if (file === 'kind' && args[0] === 'get' && args[1] === 'clusters') {
        return Promise.reject(Object.assign(new Error('exit 125'), { stderr: 'cannot connect to podman' }))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const err = await runClusterSetup({}, makeDeps({ run })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toContain('kind get clusters')
    expect((err as Error).message).toContain('cannot connect to podman')
    expect((err as Error).message).not.toContain('kind#4203')
  })

  it('fails with the rootful-podman fix when the rootful socket is unreachable', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'podman' && args[0] === '--version') {
        return Promise.resolve({ stdout: 'podman version 6.0.0\n', stderr: '' })
      }
      if (file === 'kind' && args[0] === 'version') {
        return Promise.resolve({ stdout: 'kind v0.33.0-alpha go1.24.4 linux/arm64\n', stderr: '' })
      }
      if (file === 'podman' && args[0] === 'info') {
        return Promise.reject(Object.assign(new Error('exit 125'), { stderr: 'cannot connect' }))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const err = await runClusterSetup({}, makeDeps({ run, platform: 'linux' })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toContain('systemctl enable --now podman.socket')
  })

  it('adds the skew hint to a probe failure when the kind alpha may predate the fix', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'podman' && args[0] === '--version') {
        return Promise.resolve({ stdout: 'podman version 6.0.0\n', stderr: '' })
      }
      if (file === 'kind' && args[0] === 'version') {
        return Promise.resolve({ stdout: 'kind v0.33.0-alpha go1.26.4 darwin/arm64\n', stderr: '' })
      }
      if (file === 'kind' && args[0] === 'get' && args[1] === 'clusters') {
        return Promise.reject(Object.assign(new Error('exit 125'), { stderr: 'failed to list clusters' }))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const err = await runClusterSetup({}, makeDeps({ run })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toContain('kind#4203')
    expect((err as Error).message).toContain('bsklaroff/yaac/yaac-kind')
  })

  it('drops the CIDR caches so a long-lived server cannot render for the dead cluster', async () => {
    // A setup outlives the cluster it replaces. Reusing the old node `/32`s
    // in the same process names a host that no longer exists (every policy
    // fails closed), and reusing the old pod CIDRs
    // makes netd's leading RETURNs miss, DNAT'ing pod-to-pod into the proxy.
    resetClusterCidrCache()
    const stageNode = (ip: string): void => {
      vi.mocked(kubectlGetJson).mockResolvedValue({
        items: [{ status: { addresses: [{ type: 'InternalIP', address: ip }] } }],
      })
    }
    stageNode('10.89.0.7')
    expect(await nodeIpBlocks()).toEqual(['10.89.0.7/32'])

    await runClusterSetup({}, makeDeps())

    // The rebuilt cluster's node has a new address; a live cache would
    // still answer with the dead one.
    stageNode('10.89.0.9')
    expect(await nodeIpBlocks()).toEqual(['10.89.0.9/32'])
  })

  it('admits every node by tunnel address as well as InternalIP', async () => {
    // Calico sources host-originated traffic to a pod on ANOTHER node from
    // the sending node's overlay tunnel address, not its InternalIP. A
    // policy naming only InternalIPs therefore drops netd's Envoy on every
    // cross-node hop to the proxy, which presents as "sessions on some
    // nodes have no egress at all" — and never reproduces on one node,
    // where Calico exempts local host-to-pod traffic from workload policy.
    resetClusterCidrCache()
    vi.mocked(kubectlGetJson).mockResolvedValue({
      items: [
        {
          metadata: { annotations: { 'projectcalico.org/IPv4IPIPTunnelAddr': '10.244.93.192' } },
          status: { addresses: [{ type: 'InternalIP', address: '10.89.0.21' }] },
        },
        {
          metadata: { annotations: { 'projectcalico.org/IPv4VXLANTunnelAddr': '10.244.86.128' } },
          status: { addresses: [{ type: 'InternalIP', address: '10.89.0.20' }] },
        },
        // A node the overlay has not annotated yet still contributes its
        // InternalIP rather than dropping out of the policy entirely.
        { status: { addresses: [{ type: 'InternalIP', address: '10.89.0.19' }] } },
      ],
    })

    expect(await nodeIpBlocks()).toEqual([
      '10.244.86.128/32', '10.244.93.192/32',
      '10.89.0.19/32', '10.89.0.20/32', '10.89.0.21/32',
    ])
  })

  it('--repair drops the CIDR caches too — the node address is why you repair', async () => {
    resetClusterCidrCache()
    vi.mocked(kubectlGetJson).mockResolvedValue({
      items: [{ status: { addresses: [{ type: 'InternalIP', address: '10.89.0.7' }] } }],
    })
    expect(await nodeIpBlocks()).toEqual(['10.89.0.7/32'])

    await runClusterSetup({ repair: true }, makeDeps())

    vi.mocked(kubectlGetJson).mockResolvedValue({
      items: [{ status: { addresses: [{ type: 'InternalIP', address: '10.89.0.9' }] } }],
    })
    expect(await nodeIpBlocks()).toEqual(['10.89.0.9/32'])
  })

  it('--repair re-applies fixups without recreating the cluster', async () => {
    const deps = makeDeps()
    const ok = await runClusterSetup({ repair: true }, deps)

    expect(ok).toBe(true)
    expect(deps.ensureRegistry).toHaveBeenCalledOnce()
    expect(deps.ensureBuilderGuard).toHaveBeenCalledOnce()
    // Re-applied on --repair too: that is how an existing cluster picks
    // netd, the PriorityClasses and a runsc version bump up on a yaac
    // upgrade. The gVisor half no longer repairs node state — the installer
    // DaemonSet does that on its own whenever a node appears — so what
    // --repair still owns is the kind-node-container state with no agent to
    // re-apply it (sysctls, TasksMax, pids limit, registry wiring).
    expect(deps.ensureNetd).toHaveBeenCalledOnce()
    expect(deps.ensurePriorityClasses).toHaveBeenCalledOnce()
    expect(deps.ensureGvisorRuntime).toHaveBeenCalledOnce()
    // No delete/create/Calico — only the fixups and the check.
    expect(deps.run.mock.calls.some(([f, a]) => f === 'kind' && a[0] === 'delete')).toBe(false)
    expect(deps.runStreaming).not.toHaveBeenCalled()
    expect(deps.run.mock.calls.some(([f, a]) => f === 'podman' && a[0] === 'exec')).toBe(true)
    expect(deps.check).toHaveBeenCalledOnce()
  })

  it('--repair fails fast (before any mutation) when the cluster does not exist', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'kind' && args[0] === 'get' && args[1] === 'nodes') {
        return Promise.resolve({ stdout: '', stderr: 'No kind nodes found for cluster "yaac".' })
      }
      return happyRun(file, args)
    }) as RunMock
    const deps = makeDeps({ run })
    const err = await runClusterSetup({ repair: true }, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toContain('not found')
    expect(deps.ensureRegistry).not.toHaveBeenCalled()
  })

  it('refuses a podman 6 / kind <= v0.32.0 pairing, pointing at the tapped build', async () => {
    const deps = makeDeps({
      run: vi.fn((file: string, args: string[]) => {
        if (file === 'kind' && args[0] === 'version') {
          return Promise.resolve({ stdout: 'kind v0.32.0 go1.24.4 darwin/arm64\n', stderr: '' })
        }
        return happyRun(file, args)
      }) as RunMock,
    })
    await expect(runClusterSetup({}, deps)).rejects.toThrow(/kind#4201/)
    await expect(runClusterSetup({}, deps)).rejects.toThrow(/bsklaroff\/yaac\/yaac-kind/)
  })

  it.each([
    ['podman 5.x with a pre-fix kind', 'podman version 5.8.1\n', 'kind v0.32.0 go1.24 linux/amd64\n'],
    ['a kind release past the fix', 'podman version 6.0.0\n', 'kind v0.33.0 go1.24 linux/amd64\n'],
    ['a bare alpha that may carry the fix', 'podman version 6.1.0\n', 'kind v0.33.0-alpha go1.24 linux/amd64\n'],
    ['a dev build with a commit suffix', 'podman version 6.0.0\n', 'kind v0.33.0-alpha.100+f1ec7694f59f57 go1.24 linux/arm64\n'],
    ['unparseable version output', 'garbage\n', 'garbage\n'],
  ])('leaves %s to the functional probe', async (_label, podmanOut, kindOut) => {
    const deps = makeDeps({
      run: vi.fn((file: string, args: string[]) => {
        if (file === 'podman' && args[0] === '--version') {
          return Promise.resolve({ stdout: podmanOut, stderr: '' })
        }
        if (file === 'kind' && args[0] === 'version') {
          return Promise.resolve({ stdout: kindOut, stderr: '' })
        }
        return happyRun(file, args)
      }) as RunMock,
    })
    await expect(runClusterSetup({}, deps)).resolves.toBe(true)
  })

  it('runs every kind invocation under the podman provider, host env forwarded', async () => {
    const deps = makeDeps()
    await runClusterSetup({}, deps)
    const envs = [...deps.run.mock.calls, ...deps.runStreaming.mock.calls]
      .filter(([f]) => f === 'kind')
      .map(([, , opts]) => (opts as { env?: NodeJS.ProcessEnv } | undefined)?.env)
      .filter((e): e is NodeJS.ProcessEnv => !!e)
    expect(envs.length).toBeGreaterThan(0)
    for (const env of envs) {
      expect(env.KIND_EXPERIMENTAL_PROVIDER).toBe('podman')
      // The full host env rides along, not just the provider knob.
      expect(Object.keys(env).length).toBeGreaterThan(1)
    }
  })

  it('scales the machine to the host, flooring small hosts and capping big ones', async () => {
    const initArgs = async (totalmem: number, cpuCount: number): Promise<string[]> => {
      const run = vi.fn(async (file: string, args: string[]) => {
        if (file === 'podman' && args[0] === 'machine' && args[1] === 'list') {
          return { stdout: '[]', stderr: '' }
        }
        return happyRun(file, args)
      }) as RunMock
      const deps = makeDeps({
        platform: 'darwin', run,
        totalmem: () => totalmem,
        cpuCount: () => cpuCount,
      })
      await runClusterSetup({}, deps)
      return deps.runStreaming.mock.calls.find(([, a]) => a[1] === 'init')![1]
    }

    const pair = (args: string[], flag: string): string => args[args.indexOf(flag) + 1]
    // README canon on a big host: 8 cpus / 32 GiB.
    let args = await initArgs(128 * 1024 ** 3, 12)
    expect([pair(args, '--cpus'), pair(args, '--memory')]).toEqual(['8', '32768'])
    // Half the host memory on a smaller machine.
    args = await initArgs(16 * 1024 ** 3, 4)
    expect([pair(args, '--cpus'), pair(args, '--memory')]).toEqual(['4', '8192'])
    // Floor: 2 cpus / 4 GiB.
    args = await initArgs(4 * 1024 ** 3, 1)
    expect([pair(args, '--cpus'), pair(args, '--memory')]).toEqual(['2', '4096'])
  })

  it('resolves the machine provider across containers.conf and its drop-ins', async () => {
    const withSources = async (
      sources: Record<string, string>,
      dropIns: string[] = [],
    ): Promise<boolean> => {
      const run = vi.fn(async (file: string, args: string[]) => {
        if (file === 'podman' && args[0] === 'machine' && args[1] === 'list') {
          return { stdout: '[]', stderr: '' }
        }
        return happyRun(file, args)
      }) as RunMock
      const deps = makeDeps({
        platform: 'darwin', run,
        listDir: vi.fn().mockResolvedValue(dropIns),
        readTextFile: vi.fn((path: string) => {
          const isDropIn = path.includes('containers.conf.d/')
          for (const [frag, body] of Object.entries(sources)) {
            const fragIsDropIn = frag !== 'containers.conf'
            if (fragIsDropIn !== isDropIn) continue
            if (path.includes(frag)) return Promise.resolve(body)
          }
          // A containers.conf path with nothing staged for it is absent.
          if (path.includes('containers.conf')) return Promise.resolve(null)
          return fakeCalicoReadTextFile(path)
        }),
      })
      await runClusterSetup({}, deps)
      // A drop-in is written only when the effective provider is not libkrun.
      return vi.mocked(deps.writeTextFile).mock.calls
        .some(([p]) => String(p).includes('99-yaac-machine-provider.conf'))
    }

    // No source at all, and a source with no machine provider: yaac must pin one.
    expect(await withSources({})).toBe(true)
    expect(await withSources({ 'containers.conf': '[engine]\nfoo = "bar"\n' })).toBe(true)
    // A base containers.conf already naming libkrun: nothing to write.
    expect(await withSources({ 'containers.conf': '[machine]\nprovider = "libkrun"\n' })).toBe(false)
    // A later drop-in overrides an earlier source...
    expect(await withSources(
      { 'containers.conf': '[machine]\nprovider = "applehv"\n', '10-x.conf': '[machine]\nprovider = "libkrun"\n' },
      ['10-x.conf'],
    )).toBe(false)
    // ...and an unparseable drop-in is skipped without losing the earlier value.
    expect(await withSources(
      { 'containers.conf': '[machine]\nprovider = "libkrun"\n', '10-x.conf': 'not [ valid toml' },
      ['10-x.conf'],
    )).toBe(false)
  })

  function darwinDeps(
    overrides: Omit<Partial<ClusterSetupDeps>, 'run' | 'runStreaming'> & {
      run?: RunMock
      runStreaming?: StreamMock
    } = {},
  ): ClusterSetupDeps & { run: RunMock; runStreaming: StreamMock } {
    return makeDeps({ platform: 'darwin', ...overrides })
  }

  /** machine list responses: first call, then all later calls. */
  function machineRun(
    first: object[],
    later: object[],
    extra?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }> | null,
  ): RunMock {
    let listCalls = 0
    return vi.fn(async (file: string, args: string[]) => {
      if (file === 'podman' && args[0] === 'machine' && args[1] === 'list') {
        listCalls += 1
        return { stdout: JSON.stringify(listCalls === 1 ? first : later), stderr: '' }
      }
      const handled = extra?.(file, args)
      if (handled) return handled
      return happyRun(file, args)
    }) as RunMock
  }

  it('writes the libkrun drop-in and inits a rootful machine when none exists', async () => {
    const run = machineRun([], [{ Name: 'podman-machine-default', Running: false, Default: true }])
    const deps = darwinDeps({ run })
    await runClusterSetup({}, deps)

    // Provider drop-in written (no containers.conf on disk in this test).
    const write = vi.mocked(deps.writeTextFile).mock.calls[0]
    expect(write[0]).toContain('containers.conf.d/99-yaac-machine-provider.conf')
    expect(write[1]).toContain('provider = "libkrun"')

    // init --rootful with scaled resources, then start.
    const init = deps.runStreaming.mock.calls.find(([, a]) => a[1] === 'init')
    expect(init?.[1]).toContain('--rootful')
    expect(run.mock.calls.some(([f, a]) => f === 'podman' && a[1] === 'start')).toBe(true)
  })

  it('does not write a drop-in when the provider is already libkrun', async () => {
    const run = machineRun(
      [{ Name: 'podman-machine-default', Running: true, Default: true, VMType: 'libkrun' }],
      [{ Name: 'podman-machine-default', Running: true, Default: true, VMType: 'libkrun' }],
      (file, args) => {
        if (file === 'podman' && args[1] === 'inspect') {
          return Promise.resolve({ stdout: JSON.stringify([{ Rootful: true }]), stderr: '' })
        }
        return null
      },
    )
    const deps = darwinDeps({
      run,
      readTextFile: vi.fn((p: string) => Promise.resolve(
        p.endsWith('containers.conf')
          ? '[machine]\nprovider = "libkrun"\n'
          : p.includes('containers.conf.d')
            ? null
            : fakeCalicoReadTextFile(p),
      )) as unknown as ClusterSetupDeps['readTextFile'],
    })
    await runClusterSetup({}, deps)
    expect(deps.writeTextFile).not.toHaveBeenCalled()
    // Already rootful and running: nothing to stop/set/start.
    expect(run.mock.calls.some(([f, a]) => f === 'podman' && a[1] === 'start')).toBe(false)
  })

  it('stops, sets --rootful, and restarts a rootless machine', async () => {
    const run = machineRun(
      [{ Name: 'podman-machine-default', Running: true, Default: true, VMType: 'libkrun' }],
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'libkrun' }],
      (file, args) => {
        if (file === 'podman' && args[1] === 'inspect') {
          return Promise.resolve({ stdout: JSON.stringify([{ Rootful: false }]), stderr: '' })
        }
        return null
      },
    )
    const deps = darwinDeps({ run })
    await runClusterSetup({}, deps)
    const podmanMachineCalls = run.mock.calls
      .filter(([f, a]) => f === 'podman' && a[0] === 'machine')
      .map(([, a]) => a.slice(1).join(' '))
    expect(podmanMachineCalls).toContain('stop podman-machine-default')
    expect(podmanMachineCalls).toContain('set --rootful podman-machine-default')
    expect(podmanMachineCalls).toContain('start')
  })

  it('prompts before replacing a machine on another provider, and throws when declined', async () => {
    const run = machineRun(
      [{ Name: 'podman-machine-default', Running: true, Default: true, VMType: 'applehv' }],
      [{ Name: 'podman-machine-default', Running: true, Default: true, VMType: 'applehv' }],
    )
    const deps = darwinDeps({ run, confirm: vi.fn().mockResolvedValue(false) })
    const err = await runClusterSetup({}, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toContain('applehv')
    expect(run.mock.calls.some(([f, a]) => f === 'podman' && a[1] === 'rm')).toBe(false)
  })

  it('replaces a machine on another provider when confirmed', async () => {
    const run = machineRun(
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'applehv' }],
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'libkrun' }],
    )
    const deps = darwinDeps({ run, confirm: vi.fn().mockResolvedValue(true) })
    await runClusterSetup({}, deps)
    expect(run.mock.calls.some(([f, a]) =>
      f === 'podman' && a.join(' ') === 'machine rm -f podman-machine-default')).toBe(true)
    expect(deps.runStreaming.mock.calls.some(([, a]) => a[1] === 'init')).toBe(true)
  })

  it('recreates a machine provisioned by an older podman when start trips the version gate', async () => {
    let startCalls = 0
    const run = machineRun(
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'libkrun' }],
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'libkrun' }],
      (file, args) => {
        if (file === 'podman' && args[1] === 'inspect') {
          return Promise.resolve({ stdout: JSON.stringify([{ Rootful: true }]), stderr: '' })
        }
        if (file === 'podman' && args[1] === 'start') {
          startCalls += 1
          if (startCalls === 1) {
            return Promise.reject(Object.assign(new Error('exit 125'), {
              stderr: 'Error: machine was created with an older version of podman, please run podman machine reset',
            }))
          }
          return Promise.resolve({ stdout: '', stderr: '' })
        }
        return null
      },
    )
    const deps = darwinDeps({ run, confirm: vi.fn().mockResolvedValue(true) })
    await runClusterSetup({}, deps)
    expect(run.mock.calls.some(([f, a]) =>
      f === 'podman' && a.join(' ') === 'machine rm -f podman-machine-default')).toBe(true)
    expect(deps.runStreaming.mock.calls.some(([, a]) => a[1] === 'init')).toBe(true)
    expect(startCalls).toBe(2)
  })

  it('surfaces non-legacy start failures as-is', async () => {
    const run = machineRun(
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'libkrun' }],
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'libkrun' }],
      (file, args) => {
        if (file === 'podman' && args[1] === 'inspect') {
          return Promise.resolve({ stdout: JSON.stringify([{ Rootful: true }]), stderr: '' })
        }
        if (file === 'podman' && args[1] === 'start') {
          return Promise.reject(Object.assign(new Error('exit 1'), { stderr: 'krunkit crashed' }))
        }
        return null
      },
    )
    const deps = darwinDeps({ run })
    const err = await runClusterSetup({}, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toContain('krunkit crashed')
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('uses the cached Calico manifest when it matches the pin, without downloading', async () => {
    const deps = makeDeps()
    await runClusterSetup({}, deps)
    expect(deps.fetchText).not.toHaveBeenCalled()
    expect(vi.mocked(deps.writeTextFile).mock.calls.some(([p]) => String(p).includes('calico')))
      .toBe(false)
    // The manifest reaches the cluster on kubectl apply's stdin.
    const apply = deps.runStreaming.mock.calls
      .find(([f, a]) => f === 'kubectl' && a.includes('apply'))
    expect((apply?.[2] as { input?: string })?.input).toBe(FAKE_CALICO_MANIFEST)
  })

  it('downloads the pinned Calico manifest by tag, verifies it, and caches it', async () => {
    const deps = makeDeps({ readTextFile: calicoReads(() => null) })
    await runClusterSetup({}, deps)
    expect(deps.fetchText).toHaveBeenCalledWith(
      `https://raw.githubusercontent.com/projectcalico/calico/v${CALICO_VERSION}/manifests/calico.yaml`,
    )
    const written = vi.mocked(deps.writeTextFile).mock.calls
      .find(([p]) => String(p).includes(`calico-${CALICO_VERSION}.yaml`))
    expect(written?.[1]).toBe(FAKE_CALICO_MANIFEST)
  })

  it('re-downloads when the cached Calico copy no longer matches the pin', async () => {
    // A tampered-with or truncated cache must not be trusted just because
    // it is on disk — the checksum is checked on every use, not on write.
    const deps = makeDeps({ readTextFile: calicoReads(() => 'kind: DaemonSet # tampered\n') })
    await runClusterSetup({}, deps)
    expect(deps.fetchText).toHaveBeenCalledOnce()
  })

  it('refuses a Calico download that fails the checksum, and caches nothing', async () => {
    const deps = makeDeps({
      readTextFile: calicoReads(() => null),
      fetchText: vi.fn().mockResolvedValue('kind: Evil\n'),
    })
    await expect(runClusterSetup({}, deps)).rejects.toThrow(ClusterSetupError)
    await expect(runClusterSetup({}, deps)).rejects.toThrow(/does not match the pinned checksum/)
    expect(vi.mocked(deps.writeTextFile).mock.calls.some(([p]) => String(p).includes('calico')))
      .toBe(false)
  })

  it('reports an actionable error when the Calico download fails', async () => {
    const deps = makeDeps({
      readTextFile: calicoReads(() => null),
      fetchText: vi.fn().mockRejectedValue(new Error('HTTP 503 Service Unavailable')),
    })
    await expect(runClusterSetup({}, deps)).rejects.toThrow(
      /Could not download the Calico manifest.*HTTP 503/s,
    )
  })

  it('fails when the committed Calico checksum is missing (broken install)', async () => {
    const deps = makeDeps({
      readTextFile: vi.fn((p: string) => Promise.resolve(
        p.includes('calico') || p.endsWith('.sha256')
          ? null
          : 'extraMounts:\n- hostPath: $HOME\n  containerPath: $HOME\n',
      )),
    })
    await expect(runClusterSetup({}, deps)).rejects.toThrow(/checksum not found/)
  })

  // -------------------------------------------------------------------
  // --adopt-cni: installing into a cluster whose CNI yaac did not install
  // -------------------------------------------------------------------

  it('--adopt-cni installs the in-cluster layers without creating a cluster or a CNI', async () => {
    stageAdoptCidrs()
    const deps = makeDeps({ run: adoptRun() })
    const ok = await runClusterSetup({ adoptCni: true }, deps)

    expect(ok).toBe(true)
    // Nothing destructive and no CNI: the cluster and its Calico are the
    // user's, which is the entire point of the mode.
    expect(deps.run.mock.calls.some(([f, a]) => f === 'kind' && a[0] === 'delete')).toBe(false)
    expect(deps.runStreaming).not.toHaveBeenCalled()
    expect(deps.fetchText).not.toHaveBeenCalled()
    expect(deps.run.mock.calls.some(([f, a]) =>
      f === 'kubectl' && a.includes('daemonset/calico-node'))).toBe(false)

    // ...but every in-cluster layer an owned cluster gets, it gets.
    expect(deps.ensurePriorityClasses).toHaveBeenCalledOnce()
    expect(deps.ensureRegistry).toHaveBeenCalledOnce()
    expect(deps.ensureBuilderGuard).toHaveBeenCalledOnce()
    expect(deps.ensureGvisorRuntime).toHaveBeenCalledOnce()
    expect(deps.ensureNetd).toHaveBeenCalledOnce()
    // An adopted cluster can still be a kind one (the cheapest rehearsal),
    // so the node-container fixups run where the nodes are podman containers.
    expect(deps.run.mock.calls.some(([f, a]) => f === 'podman' && a[0] === 'exec')).toBe(true)
    // The finishing check is what positively probes NetworkPolicy
    // enforcement — "Calico is installed" is not evidence of it.
    expect(deps.check).toHaveBeenCalledOnce()

    // The verification's record, which is the audit trail for a cluster
    // yaac does not own.
    const log = logged(deps)
    expect(log).toContain('chainInsertMode: Insert')
    expect(log).toContain('10.244.0.0/24')
    expect(log).toContain('192.168.0.0/16')
    expect(log).toContain('veth prefix: cali*')
    expect(log).toMatch(/cali\* resolves 2 workload route\(s\) across all 1 node/)
  })

  it('--adopt-cni needs no kind, and refuses the flags that cannot mean anything with it', async () => {
    // Adopt mode creates nothing, so the local cluster tool is not part of
    // its shopping list — the target may be any cluster the kubeconfig names.
    stageAdoptCidrs()
    const deps = makeDeps({ run: adoptRun({ kind: false }) })
    await expect(runClusterSetup({ adoptCni: true }, deps)).resolves.toBe(true)

    // --repair fixes up a cluster yaac built; --nodes renders nodes it
    // creates. Both are refused before anything on the host is touched.
    for (const opts of [{ adoptCni: true, repair: true }, { adoptCni: true, nodes: 3 }]) {
      const d = makeDeps({ run: adoptRun() })
      const err = await runClusterSetup(opts, d).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ClusterSetupError)
      expect((err as Error).message).toContain('--adopt-cni')
      expect(d.run).not.toHaveBeenCalled()
      expect(d.ensureRegistry).not.toHaveBeenCalled()
    }
  })

  it('--adopt-cni refuses Calico\'s eBPF dataplane, from the CR or the container env', async () => {
    // The hard one. eBPF host-routing short-circuits host netfilter exactly
    // the way Cilium does, so netd's nat DNAT at the veth peer would never
    // see pod egress: the chain exists, counts zero, and every session
    // silently loses the internet. A warning would be read past.
    const cases: AdoptFacts[] = [
      { felix: [{ spec: { bpfEnabled: true } }] },
      {
        calico: {
          status: { numberReady: 1, desiredNumberScheduled: 1 },
          spec: {
            template: {
              spec: {
                containers: [{
                  name: 'calico-node',
                  env: [{ name: 'FELIX_BPFENABLED', value: 'true' }],
                }],
              },
            },
          },
        },
      },
    ]
    for (const facts of cases) {
      stageAdoptCidrs()
      const deps = makeDeps({ run: adoptRun(facts) })
      const err = await runClusterSetup({ adoptCni: true }, deps).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ClusterSetupError)
      expect((err as Error).message).toMatch(/eBPF dataplane/)
      expect((err as Error).message).toContain('bpfEnabled')
      // The gate runs before anything is applied: a cluster that cannot
      // work costs the user the diagnosis and nothing else.
      expect(deps.ensureRegistry).not.toHaveBeenCalled()
      expect(deps.ensureNetd).not.toHaveBeenCalled()
      expect(deps.check).not.toHaveBeenCalled()
    }
  })

  it('--adopt-cni refuses every other silent-failure shape, naming which one it is', async () => {
    const refuse = async (facts: AdoptFacts, cidrs?: Parameters<typeof stageAdoptCidrs>[0]) => {
      stageAdoptCidrs(cidrs)
      const deps = makeDeps({ run: adoptRun(facts) })
      const err = await runClusterSetup({ adoptCni: true }, deps).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ClusterSetupError)
      expect(deps.ensureRegistry).not.toHaveBeenCalled()
      return (err as Error).message
    }

    // No Calico at all — which is also how a Cilium cluster reads, and
    // there is no configuration of Cilium the veth-peer redirect survives.
    expect(await refuse({ calico: null })).toMatch(/no calico-node found/)
    expect(await refuse({ calico: null })).toMatch(/Cilium is not supported/)

    // Present but not rolled out: policy is the enforcement plane, so a
    // node without Felix is a node with no session egress lockdown.
    expect(await refuse({
      calico: { status: { numberReady: 1, desiredNumberScheduled: 3 } },
    })).toMatch(/calico-node is 1\/3 ready/)

    // No kube-proxy: netd's Envoy dials the yaac proxy by ClusterIP from
    // the host netns, and nothing would translate it.
    expect(await refuse({ kubeProxyPods: [] })).toMatch(/no kube-proxy pod found/)
    // Calico replacing kube-proxy is the same failure, declared.
    expect(await refuse({ felix: [{ spec: { bpfKubeProxyIptablesCleanupEnabled: true } }] }))
      .toMatch(/replacing kube-proxy/)

    // Nothing publishes a pod CIDR. An empty exclusion set makes netd DNAT
    // pod-to-pod 443/80 into the proxy, so this refuses rather than
    // falling back to kind's default the way the per-apply path does.
    const noCidrs = await refuse({}, { pools: [], nodeCidrs: [] })
    expect(noCidrs).toMatch(/no pod CIDR could be resolved/)
    expect(noCidrs).toContain('YAAC_POD_CIDRS')

    // netd names system-node-critical, and the apiserver rejects a pod
    // naming a class it does not have — for a DaemonSet that means no netd
    // pod is ever created.
    expect(await refuse({ systemNodeCritical: false }))
      .toMatch(/system-node-critical PriorityClass is missing/)
  })

  it('--adopt-cni records Append chainInsertMode and the node-podCIDR-only shape as warnings', async () => {
    // Neither breaks the datapath — netd appends its own jump and never
    // competes with Felix for position — but both are things the operator
    // of a cluster yaac does not own should be told.
    stageAdoptCidrs({ pools: [], nodeCidrs: ['10.244.0.0/24'] })
    const deps = makeDeps({ run: adoptRun({ felix: [{ spec: { chainInsertMode: 'Append' } }] }) })
    await expect(runClusterSetup({ adoptCni: true }, deps)).resolves.toBe(true)

    const log = logged(deps)
    expect(log).toContain('chainInsertMode: Append')
    expect(log).toMatch(/Append chainInsertMode/)
    expect(log).toMatch(/only pod-CIDR source is node spec\.podCIDR/)
    expect(log).toContain('YAAC_POD_CIDRS')
  })

  it('--adopt-cni honors an explicit pod-CIDR and veth-prefix config, verifying the prefix on a node', async () => {
    // Policy-only Calico over a foreign IPAM: pod IPs appear in no IPPool
    // and no spec.podCIDR, and workload veths are named `eni*`. Both are
    // configuration — and the prefix is verified against the node's real
    // routing table, since a prefix that matches nothing renders a redirect
    // chain with no per-pod rules, indistinguishable from a healthy netd.
    vi.stubEnv('YAAC_POD_CIDRS', '172.31.0.0/16')
    vi.stubEnv('YAAC_CNI_VETH_PREFIX', 'eni')
    stageAdoptCidrs({ pools: [], nodeCidrs: [] })
    const deps = makeDeps({
      run: adoptRun({ routes: '10.0.3.41 dev enia7b3c9d1e2f4 scope link' }),
    })
    await expect(runClusterSetup({ adoptCni: true }, deps)).resolves.toBe(true)

    const log = logged(deps)
    expect(log).toContain('172.31.0.0/16')
    expect(log).toContain('from YAAC_POD_CIDRS')
    expect(log).toContain('veth prefix: eni*')
    expect(log).toMatch(/eni\* resolves 1 workload route\(s\) across all 1 node/)
  })

  it('--adopt-cni refuses a veth prefix that resolves nothing, and names the one that would', async () => {
    // The pod → veth binding is netd's ONLY source of the identity a
    // sandboxed workload cannot forge. Read through netd itself, which is
    // hostNetwork and ships iproute2, so it is the node's own view.
    stageAdoptCidrs()
    const deps = makeDeps({
      run: adoptRun({ routes: '10.0.3.41 dev enia7b3c9d1e2f4 scope link' }),
    })
    const err = await runClusterSetup({ adoptCni: true }, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toMatch(/no per-workload host route matches cali\*/)
    // The suggested prefix is the veth FAMILY, not the family plus however
    // many leading hash characters happen to be letters: hex digits are
    // letters too, so `enia7b3c9d1e2f4` must yield `eni`, not `enia` (which
    // would match exactly the one veth the user was shown).
    expect((err as Error).message).toMatch(/YAAC_CNI_VETH_PREFIX=eni\b/)
    // This one runs LAST, after netd is on a node — there is no other way
    // to see the routing table — so the layers below it were applied.
    expect(deps.ensureNetd).toHaveBeenCalledOnce()

    // A CNI writing no per-workload route at all cannot be adopted either,
    // and there is no prefix to suggest.
    stageAdoptCidrs()
    const bare = makeDeps({ run: adoptRun({ routes: 'default via 10.89.0.1 dev eth0' }) })
    await expect(runClusterSetup({ adoptCni: true }, bare))
      .rejects.toThrow(/no per-workload host route at all/)
  })

  it('--adopt-cni refuses a check it could not EVALUATE, not just one that failed', async () => {
    // The fail-open this gate cannot afford. Absence is a fact with meaning
    // — no FelixConfiguration means Felix runs its iptables defaults — so a
    // read that merely ERRORED must not read as absence, or an RBAC-denied
    // FelixConfiguration would wave an eBPF cluster straight through and
    // land as silent no-egress.
    for (const denied of ['felix', 'kube-proxy', 'nodes', 'calico'] as const) {
      stageAdoptCidrs()
      const deps = makeDeps({ run: adoptRun({ denied }) })
      const err = await runClusterSetup({ adoptCni: true }, deps).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ClusterSetupError)
      expect((err as Error).message).toMatch(/could not be evaluated/)
      expect((err as Error).message).toMatch(/Forbidden/)
      expect(deps.ensureRegistry).not.toHaveBeenCalled()
      // A read that FAILED must not also be reported as an absence the gate
      // never established: two refusals, one of them pointing at the wrong
      // fix, is a dishonest diagnosis even when both refuse. "No calico-node
      // in kube-system" reads as a Cilium cluster; "no kube-proxy" sends the
      // user to YAAC_KUBE_PROXY_EXTERNAL. Neither was established.
      const absenceClaims: Record<typeof denied, RegExp> = {
        calico: /no calico-node found/,
        'kube-proxy': /no kube-proxy pod found/,
        nodes: /no pod CIDR could be resolved/,
        felix: /eBPF dataplane/,
      }
      expect((err as Error).message).not.toMatch(absenceClaims[denied])
      // Nor may the RECORD claim one. "chainInsertMode: Insert (Felix
      // default — nothing sets it)" is a statement about the cluster, and
      // an audit trail asserting one the gate never established is worse
      // than one that stays silent.
      if (denied === 'felix') expect(logged(deps)).not.toMatch(/chainInsertMode/)
    }

    // The pod-CIDR sources read through a different runner, so an RBAC
    // denial scoped to `ippools` alone would otherwise present as "Calico
    // publishes no pool" and silently narrow the exclusion set.
    resetClusterCidrCache()
    vi.mocked(kubectlGetJson).mockImplementation(((args: string[]) => {
      if (args[1]?.startsWith('ippools')) {
        return Promise.reject(Object.assign(new Error('exit 1'), {
          stderr: 'Error from server (Forbidden): ippools.crd.projectcalico.org is forbidden',
        }))
      }
      return Promise.resolve({ items: [{ spec: { podCIDR: '10.244.0.0/24' } }] })
    }) as never)
    const cidrDeps = makeDeps({ run: adoptRun() })
    const cidrErr = await runClusterSetup({ adoptCni: true }, cidrDeps).catch((e: unknown) => e)
    expect(cidrErr).toBeInstanceOf(ClusterSetupError)
    expect((cidrErr as Error).message).toMatch(/pod-CIDR source: Calico IPPools/)
    expect(cidrDeps.ensureRegistry).not.toHaveBeenCalled()

    // A CRD the cluster does not serve at all is the OTHER outcome, and it
    // must stay a fact: a provider-managed Calico serves no
    // FelixConfiguration, which means Felix's iptables defaults — exactly
    // what yaac wants.
    stageAdoptCidrs()
    const ok = makeDeps({ run: adoptRun() })
    await expect(runClusterSetup({ adoptCni: true }, ok)).resolves.toBe(true)
    expect(logged(ok)).toMatch(/no FelixConfiguration sets it/)
  })

  it('--adopt-cni sees eBPF in a per-node FelixConfiguration and in Felix\'s wider booleans', async () => {
    const refuse = async (facts: AdoptFacts): Promise<string> => {
      stageAdoptCidrs()
      const deps = makeDeps({ run: adoptRun(facts) })
      const err = await runClusterSetup({ adoptCni: true }, deps).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ClusterSetupError)
      expect(deps.ensureNetd).not.toHaveBeenCalled()
      return (err as Error).message
    }

    // Felix honors per-node overrides, so reading only `default` would miss
    // a cluster whose default leaves bpfEnabled unset and whose
    // `node.<name>` object turns it on.
    expect(await refuse({
      felix: [
        { metadata: { name: 'default' }, spec: { chainInsertMode: 'Insert' } },
        { metadata: { name: 'node.worker-1' }, spec: { bpfEnabled: true } },
      ],
    })).toMatch(/eBPF dataplane/)

    // Felix's env boolean parsing is wider than true|1 — `yes` enables it.
    const withEnv = (value?: string, valueFrom?: object): AdoptFacts => ({
      calico: {
        status: { numberReady: 1, desiredNumberScheduled: 1 },
        spec: {
          template: {
            spec: {
              containers: [{
                name: 'calico-node',
                env: [{ name: 'FELIX_BPFENABLED', ...(valueFrom ? { valueFrom } : { value }) }],
              }],
            },
          },
        },
      },
    })
    for (const truthy of ['yes', 'Y', 't', 'ON', '1', 'TRUE']) {
      expect(await refuse(withEnv(truthy))).toMatch(/eBPF dataplane/)
    }

    // A `valueFrom` entry carries no literal value, so the manifest does not
    // say what the dataplane is — and "cannot tell" must not collapse into
    // "off", which is the direction that ends in silent no-egress.
    expect(await refuse(withEnv(undefined, { configMapKeyRef: { name: 'felix', key: 'bpf' } })))
      .toMatch(/valueFrom/)

    // The recognizably-false spellings still pass, or the gate would refuse
    // every healthy cluster that sets the variable explicitly.
    for (const falsey of ['false', 'no', '0', 'off', 'F']) {
      stageAdoptCidrs()
      const deps = makeDeps({ run: adoptRun(withEnv(falsey)) })
      await expect(runClusterSetup({ adoptCni: true }, deps)).resolves.toBe(true)
    }
  })

  it('--adopt-cni finds kube-proxy however the cluster labels it, and accepts a declared external one', async () => {
    // kubeadm/EKS/kind stamp `k8s-app`; GKE and AKS stamp `component`. A
    // label mismatch would falsely REFUSE the very clusters this mode
    // advertises — fail-closed, but an adoption blocker.
    stageAdoptCidrs()
    const gke = makeDeps({ run: adoptRun({ kubeProxyLabel: 'component' }) })
    await expect(runClusterSetup({ adoptCni: true }, gke)).resolves.toBe(true)

    // k3s runs kube-proxy in-process inside the kubelet: no pod, no
    // DaemonSet, no label. Self-managed k3s is a PRIMARY target, so the
    // refusal names the case and an explicit acknowledgement clears it —
    // recorded, since it is the one check an operator can wave through.
    stageAdoptCidrs()
    const k3sRefusal = await runClusterSetup(
      { adoptCni: true }, makeDeps({ run: adoptRun({ kubeProxyPods: [] }) }),
    ).catch((e: unknown) => (e as Error).message)
    expect(k3sRefusal).toMatch(/YAAC_KUBE_PROXY_EXTERNAL=1/)
    expect(k3sRefusal).toMatch(/k3s runs it in-process/)

    vi.stubEnv('YAAC_KUBE_PROXY_EXTERNAL', '1')
    stageAdoptCidrs()
    const k3s = makeDeps({ run: adoptRun({ kubeProxyPods: [] }) })
    await expect(runClusterSetup({ adoptCni: true }, k3s)).resolves.toBe(true)
    expect(logged(k3s)).toMatch(/declared external/)
  })

  it('--adopt-cni warns per NODE about kube-proxy and refuses per NODE about veths', async () => {
    // One running kube-proxy proves the cluster has one; it says nothing
    // about the node a session actually lands on. A node without one loses
    // egress by itself while the rest work, which reads as intermittent.
    const nodes = [{ name: 'cp' }, { name: 'w1' }, { name: 'w2' }]
    stageAdoptCidrs()
    const partial = makeDeps({
      run: adoptRun({
        nodes,
        kubeProxyPods: [
          { spec: { nodeName: 'cp' }, status: { phase: 'Running' } },
          { spec: { nodeName: 'w1' }, status: { phase: 'Running' } },
        ],
      }),
    })
    await expect(runClusterSetup({ adoptCni: true }, partial)).resolves.toBe(true)
    expect(logged(partial)).toMatch(/no running kube-proxy on 1 session-capable node\(s\): w2/)

    // Which nodes count is answered by real per-taint matching against the
    // gvisor RuntimeClass's tolerations — the same model `cluster check`
    // uses. A dedicated sessions pool is a TAINTED pool plus a matching
    // toleration on the class, so a blanket "any taint disqualifies" rule
    // would read it as zero session-capable nodes and check nothing at all.
    stageAdoptCidrs()
    const pool = makeDeps({
      run: adoptRun({
        nodes: [{ name: 'cp', taint: 'node-role.kubernetes.io/control-plane' },
          { name: 'pool-1', taint: 'yaac.sessions' },
          { name: 'pool-2', taint: 'yaac.sessions' }],
        tolerations: [{ key: 'yaac.sessions', operator: 'Exists' }],
        kubeProxyPods: [{ spec: { nodeName: 'pool-1' }, status: { phase: 'Running' } }],
      }),
    })
    await expect(runClusterSetup({ adoptCni: true }, pool)).resolves.toBe(true)
    // pool-2 is tolerated and therefore in scope, and IS uncovered; the
    // control plane is not tolerated, so it is out of scope entirely.
    expect(logged(pool)).toMatch(/no running kube-proxy on 1 session-capable node\(s\): pool-2/)
    expect(logged(pool)).not.toMatch(/\bcp\b/)

    // The veth sweep is per node too, and `exec daemonset/...` would have
    // sampled only one: on a heterogeneous fleet (mixed pools or AMIs) one
    // node's routing table says nothing about the others'.
    stageAdoptCidrs()
    const mixed = makeDeps({
      run: adoptRun({
        nodes,
        routes: {
          'yaac-netd-0': ADOPT_ROUTES,
          'yaac-netd-1': ADOPT_ROUTES,
          // This node's CNI names its veths differently — its sessions
          // would get a redirect chain with no rules in it.
          'yaac-netd-2': '10.0.3.41 dev enia7b3c9d1e2f4 scope link',
        },
      }),
    })
    const err = await runClusterSetup({ adoptCni: true }, mixed).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toMatch(/matches cali\* on w2/)
    expect((err as Error).message).toMatch(/2 other node\(s\) resolve fine/)
    expect((err as Error).message).toMatch(/YAAC_CNI_VETH_PREFIX=eni\b/)

    // But a node with NO per-workload route of any kind is ambiguous, not a
    // mismatch: netd and kube-proxy are hostNetwork and own no veth, so
    // that is also exactly what a freshly added node looks like. Warn where
    // others resolve; only refuse when nothing anywhere does.
    stageAdoptCidrs()
    const idle = makeDeps({
      run: adoptRun({
        nodes,
        routes: {
          'yaac-netd-0': ADOPT_ROUTES,
          'yaac-netd-1': ADOPT_ROUTES,
          'yaac-netd-2': 'default via 10.89.0.1 dev eth0',
        },
      }),
    })
    await expect(runClusterSetup({ adoptCni: true }, idle)).resolves.toBe(true)
    expect(logged(idle)).toMatch(/w2 have no per-workload route at all/)
  })

  it('--adopt-cni refuses a YAAC_POD_CIDRS entry it cannot use rather than dropping it', async () => {
    // A typo'd entry that merely vanished would leave the exclusion set
    // NARROWER than what the operator wrote, with nothing to tell them: the
    // recorded list shows only what survived. Narrower means those pods'
    // 443/80 goes into the proxy.
    vi.stubEnv('YAAC_POD_CIDRS', '172.31.0.0/16, 172.31/16, 999.1.1.1/99, 10.0.0.0/33')
    stageAdoptCidrs()
    const deps = makeDeps({ run: adoptRun() })
    const err = await runClusterSetup({ adoptCni: true }, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    const msg = (err as Error).message
    expect(msg).toMatch(/not usable IPv4 CIDRs/)
    // Out-of-range octets and masks are rejected too — they would otherwise
    // reach iptables-restore, which rejects the WHOLE document on one bad
    // line and stalls every redirect update on the node.
    expect(msg).toContain('172.31/16')
    expect(msg).toContain('999.1.1.1/99')
    expect(msg).toContain('10.0.0.0/33')
    expect(deps.ensureRegistry).not.toHaveBeenCalled()
  })

  it('--adopt-cni treats an unreachable netd as unverified rather than refused', async () => {
    // netd deploys fail-soft (the server re-ensures it on every proxy
    // bootstrap), so "I could not read the routing table" is a different
    // claim from "this cluster has no workload routes" — and the cluster
    // check's datapath gate is what owns the first one.
    stageAdoptCidrs()
    const deps = makeDeps({ run: adoptRun({ routes: null }) })
    await expect(runClusterSetup({ adoptCni: true }, deps)).resolves.toBe(true)
    expect(logged(deps)).toMatch(/unverified on yaac-control-plane/)
  })

  it('mirrors the deduped image set the Calico manifest names, and nothing else', async () => {
    const manifest = [
      '        - name: upgrade-ipam',
      '          image: quay.io/calico/cni:v3.32.1',
      '        - name: install-cni',
      '          image: quay.io/calico/cni:v3.32.1',
      '          image: quay.io/calico/node:v3.32.1',
      '  # image: not-a-ref',
      '  imagePullPolicy: IfNotPresent',
    ].join('\n')
    const sha = crypto.createHash('sha256').update(manifest, 'utf8').digest('hex')
    const deps = makeDeps({
      readTextFile: vi.fn((p: string) => Promise.resolve(
        p.endsWith('.sha256')
          ? `${sha}  calico.yaml\n`
          : p.includes('calico')
            ? manifest
            : 'extraMounts:\n- hostPath: $HOME\n  containerPath: $HOME\n',
      )),
    })
    await runClusterSetup({}, deps)

    const pulled = deps.run.mock.calls
      .filter(([f, a]) => f === 'podman' && a[0] === 'image' && a[1] === 'exists')
      .map(([, a]) => a[2])
    // Deduped and sorted; prose and non-image keys are not refs.
    expect(pulled.filter((r) => r.includes('calico'))).toEqual([
      'quay.io/calico/cni:v3.32.1',
      'quay.io/calico/node:v3.32.1',
    ])
    expect(pulled).not.toContain('not-a-ref')
  })
})
