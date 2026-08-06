import crypto from 'node:crypto'
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('#platform/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

import { ClusterSetupError, runClusterSetup } from '#features/cluster'
// The deps shape is part of the public interface (runClusterSetup takes one);
// CALICO_VERSION is a pinned setup value for the assertions.
import { CALICO_VERSION, type ClusterSetupDeps } from '#features/cluster/setup'
import { nodeIpBlocks, resetClusterCidrCache } from '#features/cluster/cluster-cidrs'
import { kubectlGetJson } from '#platform/k8s/kubectl'
import { NODE_KUBELET_HOUSEKEEPING_INTERVAL } from '#features/cluster/check'

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

  it('refuses to run inside a nested yaac session', async () => {
    vi.stubEnv('YAAC_NESTED', '1')
    const deps = makeDeps()
    const err = await runClusterSetup({}, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toContain('nested')
    expect(deps.run).not.toHaveBeenCalled()
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
