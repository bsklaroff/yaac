import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

vi.mock('@/lib/k8s/kubectl', () => ({
  execFileAsync: vi.fn(),
  k8sNamespace: vi.fn(() => 'test-ns'),
  kubectlApply: vi.fn(),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn(),
}))

import {
  formatCheckResult,
  runClusterCheck,
  type CheckResult,
  type ClusterCheckDeps,
} from '@/lib/k8s/cluster-check'
import { clusterIpForNamespace } from '@/lib/k8s/bootstrap'
import { kubectlGetJson } from '@/lib/k8s/kubectl'
import { sessionUid } from '@/lib/container/image-builder'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@test/helpers/setup'

const mockGetJson = vi.mocked(kubectlGetJson)

type RunMock = ReturnType<typeof vi.fn<
  (file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string }>
>>

/**
 * Stand-in for the probe pod's side effect: the pod writes a marker file
 * through the hostPath mount, which the check verifies host-side. Called
 * from the mocked `kubectl logs` branch (the pod has "finished" by then).
 */
async function simulateProbeWrite(): Promise<void> {
  await fs.writeFile(path.join(getDataDir(), '.cluster-check-write'), 'ok\n')
}

/** The marker the relay probe prints when the REDIRECT delivers. */
const REDIRECT_PROBE_MARKER = 'REDIRECT_OK'

/**
 * deps.run implementation covering every probe the all-pass path makes.
 * `kubectl logs` echoes back the nonce file runClusterCheck wrote so the
 * end-to-end probe's freshness assertion passes, and drops the probe
 * pod's write marker so the hostPath write-back assertion passes.
 */
async function happyResponses(
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'nodes') {
    return { stdout: JSON.stringify({ items: [{}] }), stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'svc' && args[2] === 'kubernetes') {
    return { stdout: '10.96.0.1', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'svc' && args[2] === 'kube-dns') {
    return { stdout: '10.96.0.10', stderr: '' }
  }
  // The yaac-proxy Service is absent in the happy path (it deploys lazily).
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'configmap' && args[2] === 'kubeadm-config') {
    return {
      stdout: 'networking:\n  podSubnet: 10.244.0.0/16\n  serviceSubnet: 10.96.0.0/16\n',
      stderr: '',
    }
  }
  if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-egress') {
    return { stdout: 'NP_BLOCKED\n', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-redirect') {
    return {
      stdout: `[relay] probe listening\nRESOLVED:198.18.0.1\nDENY_FAST\n${REDIRECT_PROBE_MARKER}\n`,
      stderr: '',
    }
  }
  if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-nested') {
    return { stdout: 'NESTED_MOUNT_OK\n', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'logs') {
    const nonce = await fs.readFile(path.join(getDataDir(), '.cluster-check-nonce'), 'utf8')
    await simulateProbeWrite()
    return { stdout: `${nonce}\n`, stderr: '' }
  }
  return { stdout: '', stderr: '' }
}

function happyRun(): RunMock {
  return vi.fn(happyResponses)
}

/** Pod-phase responses: every probe pod completes successfully. */
function happyGetJson(_args: string[]): unknown {
  return { status: { phase: 'Succeeded' } }
}

function makeDeps(
  overrides: Omit<Partial<ClusterCheckDeps>, 'run'> & { run?: RunMock } = {},
): ClusterCheckDeps & { run: RunMock } {
  const run = overrides.run ?? happyRun()
  return {
    run: run as unknown as ClusterCheckDeps['run'],
    registryReachable: overrides.registryReachable ?? vi.fn().mockResolvedValue(true),
    pushImage: overrides.pushImage
      ?? vi.fn().mockResolvedValue('localhost:5000/yaac-cluster-probe:busybox-1.36'),
    ensureNamespace: overrides.ensureNamespace ?? vi.fn().mockResolvedValue(undefined),
    apply: overrides.apply ?? vi.fn().mockResolvedValue(undefined),
    ensureRedirectInitImage: overrides.ensureRedirectInitImage
      ?? vi.fn().mockResolvedValue('localhost:5000/yaac-redirect-init:test'),
    ensureRelayImage: overrides.ensureRelayImage
      ?? vi.fn().mockResolvedValue('localhost:5000/yaac-relay:test'),
  } as ClusterCheckDeps & { run: RunMock }
}

function byName(results: CheckResult[], name: string): CheckResult | undefined {
  return results.find((r) => r.name === name)
}

describe('runClusterCheck', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    mockGetJson.mockReset()
    // Probe pods complete successfully unless a test overrides.
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve(happyGetJson(args)))
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('passes every check on a healthy single-node cluster', async () => {
    const deps = makeDeps()
    const { ok, results } = await runClusterCheck(deps)

    expect(results.map((r) => [r.name, r.status])).toEqual([
      ['kubectl', 'pass'],
      ['cluster', 'pass'],
      ['nodes', 'pass'],
      ['podman', 'pass'],
      ['registry', 'pass'],
      ['namespace', 'pass'],
      ['probe', 'pass'],
      ['egress', 'pass'],
      ['redirect', 'pass'],
      ['lockdown', 'pass'],
      ['dns-stub', 'pass'],
      ['nested-mount', 'pass'],
      // The proxy deploys lazily, so its VIP pin is unverifiable here.
      ['proxy-vip', 'skip'],
      ['service-cidr', 'pass'],
    ])
    expect(ok).toBe(true)
    expect(deps.ensureRedirectInitImage).toHaveBeenCalled()
    expect(deps.ensureRelayImage).toHaveBeenCalled()
    expect(byName(results, 'redirect')?.detail).toContain('REDIRECT delivers')

    // Probe ran through the deps: image pushed, pod applied, pod deleted.
    expect(deps.pushImage).toHaveBeenCalledWith('yaac-cluster-probe:busybox-1.36')
    const probePod = vi.mocked(deps.apply).mock.calls
      .map((c) => c[0] as { kind: string; metadata?: { name?: string } })
      .find((m) => m.kind === 'Pod' && m.metadata?.name === 'yaac-cluster-check')
    expect(probePod).toBeDefined()
    const podManifest = probePod as {
      kind: string
      spec: {
        hostUsers: boolean
        securityContext: { seccompProfile: { type: string } }
        containers: Array<{
          securityContext?: { runAsUser?: number }
          volumeMounts: Array<{ readOnly?: boolean }>
        }>
        volumes: Array<{ hostPath: { path: string } }>
      }
    }
    expect(podManifest.kind).toBe('Pod')
    expect(podManifest.spec.volumes[0].hostPath.path).toBe(getDataDir())
    // The probe mirrors the session-pod hardening so it catches clusters
    // that cannot run user-namespaced pods.
    expect(podManifest.spec.hostUsers).toBe(false)
    expect(podManifest.spec.securityContext).toEqual({
      seccompProfile: { type: 'RuntimeDefault' },
    })
    // The probe writes through the mount at the session-image uid, so it
    // must run at that uid with a read-write mount.
    expect(podManifest.spec.containers[0].securityContext).toEqual({
      runAsUser: sessionUid(),
    })
    expect(podManifest.spec.containers[0].volumeMounts[0].readOnly).toBeUndefined()
    // The nonce and write-marker files are cleaned up afterwards.
    await expect(
      fs.access(path.join(getDataDir(), '.cluster-check-nonce')),
    ).rejects.toThrow()
    await expect(
      fs.access(path.join(getDataDir(), '.cluster-check-write')),
    ).rejects.toThrow()
  })

  it('short-circuits with a single failure when kubectl is missing', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'kubectl' && args.includes('--client')) {
        return Promise.reject(new Error('ENOENT: kubectl'))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const { ok, results } = await runClusterCheck(makeDeps({ run }))

    expect(ok).toBe(false)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ name: 'kubectl', status: 'fail' })
    expect(results[0].fix).toContain('Install kubectl')
  })

  it('short-circuits after the cluster check when the API server is unreachable', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'version' && !args.includes('--client')) {
        return Promise.reject(new Error('connection refused'))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const { ok, results } = await runClusterCheck(makeDeps({ run }))

    expect(ok).toBe(false)
    expect(results.map((r) => r.name)).toEqual(['kubectl', 'cluster'])
    expect(byName(results, 'cluster')).toMatchObject({ status: 'fail' })
    expect(byName(results, 'cluster')?.detail).toContain('API server unreachable')
  })

  it('warns (without failing) on multi-node clusters and still runs the probe', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'nodes') {
        return { stdout: JSON.stringify({ items: [{}, {}] }), stderr: '' }
      }
      return happyResponses(file, args)
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))

    expect(byName(results, 'nodes')).toMatchObject({ status: 'warn' })
    expect(byName(results, 'probe')).toMatchObject({ status: 'pass' })
    expect(ok).toBe(true)
  })

  it('skips the end-to-end probe when an earlier check failed', async () => {
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'podman' && args[0] === '--version') {
        return Promise.reject(new Error('podman missing'))
      }
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'nodes') {
        return Promise.resolve({ stdout: JSON.stringify({ items: [{}] }), stderr: '' })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    const deps = makeDeps({ run })
    const { ok, results } = await runClusterCheck(deps)

    expect(ok).toBe(false)
    expect(byName(results, 'podman')).toMatchObject({ status: 'fail' })
    expect(byName(results, 'probe')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'egress')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'redirect')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'lockdown')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'dns-stub')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'nested-mount')).toMatchObject({ status: 'skip' })
    expect(deps.pushImage).not.toHaveBeenCalled()
    expect(deps.ensureRedirectInitImage).not.toHaveBeenCalled()
    expect(deps.ensureRelayImage).not.toHaveBeenCalled()
    expect(deps.apply).not.toHaveBeenCalled()
  })

  it('passes the egress check when a session-labeled pod cannot reach the apiserver', async () => {
    const { results } = await runClusterCheck(makeDeps())
    expect(byName(results, 'egress')).toMatchObject({
      status: 'pass',
      detail: expect.stringContaining('NetworkPolicy enforced') as string,
    })
  })

  it('fails the egress check when the CNI does not enforce NetworkPolicy', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'nodes') {
        return { stdout: JSON.stringify({ items: [{}] }), stderr: '' }
      }
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'svc') {
        return { stdout: '10.96.0.1', stderr: '' }
      }
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-egress') {
        // Policy not enforced: the probe reached the apiserver.
        return { stdout: 'NP_REACHED\n', stderr: '' }
      }
      if (file === 'kubectl' && args[0] === 'logs') {
        const nonce = await fs.readFile(path.join(getDataDir(), '.cluster-check-nonce'), 'utf8')
        await simulateProbeWrite()
        return { stdout: `${nonce}\n`, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    expect(ok).toBe(false)
    const egress = byName(results, 'egress')
    expect(egress).toMatchObject({ status: 'fail' })
    expect(egress?.detail).toContain('not enforcing NetworkPolicy')
    expect(egress?.fix).toContain('kindnet')
  })

  it('fails the egress check when the proxy is deployed but unreachable from a session pod', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'svc' && args[2] === 'yaac-proxy') {
        return { stdout: '10.96.7.7', stderr: '' }
      }
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-egress') {
        return { stdout: 'NP_BLOCKED\nNP_PROXY_BLOCKED\n', stderr: '' }
      }
      return happyResponses(file, args)
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    expect(ok).toBe(false)
    const egress = byName(results, 'egress')
    expect(egress).toMatchObject({ status: 'fail' })
    expect(egress?.detail).toContain('cannot reach the proxy')
  })

  it('passes the redirect, lockdown, and dns-stub gates from one session-shaped probe pod', async () => {
    const deps = makeDeps()
    const { results } = await runClusterCheck(deps)
    expect(byName(results, 'redirect')).toMatchObject({ status: 'pass' })
    expect(byName(results, 'lockdown')).toMatchObject({ status: 'pass' })
    expect(byName(results, 'dns-stub')).toMatchObject({ status: 'pass' })
    // The probe pod runs the real redirect.sh + relay contract: NET_ADMIN
    // init container, user-namespaced pod, relay in probe mode.
    const probePod = vi.mocked(deps.apply).mock.calls
      .map((c) => c[0] as { kind: string; metadata?: { name?: string } })
      .find((m) => m.kind === 'Pod' && m.metadata?.name === 'yaac-cluster-check-redirect') as {
      metadata: { labels?: Record<string, string> }
      spec: {
        hostUsers: boolean
        initContainers: Array<{
          securityContext: { capabilities: { add: string[] } }
          env: Array<{ name: string; value: string }>
        }>
        containers: Array<{ image: string; env: Array<{ name: string; value: string }> }>
      }
    } | undefined
    expect(probePod).toBeDefined()
    expect(probePod?.spec.hostUsers).toBe(false)
    // Session-shaped: the egress NetworkPolicy selects the pod, so the
    // lockdown gate's timing separates in-pod REJECT from CNI DROP.
    expect(probePod?.metadata.labels?.['yaac.session-id']).toBeTruthy()
    expect(probePod?.spec.initContainers[0].securityContext)
      .toEqual({ capabilities: { add: ['NET_ADMIN'] } })
    // redirect-init installs the REDIRECT, not a DNAT-to-ClusterIP.
    expect(probePod?.spec.initContainers[0].env).toContainEqual(
      { name: 'REDIRECT_HTTPS_PORT', value: '15001' },
    )
    // The filter default-deny params ride along (redirect.sh requires
    // them); the carve-out targets the pinned VIP, never a CIDR.
    expect(probePod?.spec.initContainers[0].env).toContainEqual({ name: 'REDIRECT_DNS_PORT', value: '15004' })
    expect(probePod?.spec.initContainers[0].env).toContainEqual({ name: 'RELAY_UID', value: '1337' })
    expect(probePod?.spec.initContainers[0].env).toContainEqual({
      name: 'PROXY_CLUSTER_IP', value: clusterIpForNamespace('test-ns'),
    })
    expect(probePod?.spec.initContainers[0].env.some(
      (e) => e.name === 'SERVICE_CIDR' || e.name === 'POD_CIDR',
    )).toBe(false)
    expect(probePod?.spec.initContainers[0].env).toContainEqual({ name: 'TRANSPARENT_HTTPS_PORT', value: '10256' })
    // The probe container is the relay image in probe mode + DNS stub.
    expect(probePod?.spec.containers[0].image).toBe('localhost:5000/yaac-relay:test')
    expect(probePod?.spec.containers[0].env).toContainEqual({ name: 'RELAY_PROBE', value: '1' })
    expect(probePod?.spec.containers[0].env).toContainEqual({ name: 'LISTEN_DNS_PORT', value: '15004' })
  })

  it('fails the lockdown gate when non-proxy egress is only stopped by the CNI (slow)', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-redirect') {
        return { stdout: `RESOLVED:198.18.0.1\nDENY_SLOW\n${REDIRECT_PROBE_MARKER}\n`, stderr: '' }
      }
      return happyResponses(file, args)
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    expect(ok).toBe(false)
    const lockdown = byName(results, 'lockdown')
    expect(lockdown).toMatchObject({ status: 'fail' })
    expect(lockdown?.detail).toContain('in-pod filter REJECT')
    expect(byName(results, 'redirect')).toMatchObject({ status: 'pass' })
  })

  it('fails the lockdown gate when both the filter and NetworkPolicy fail open', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-redirect') {
        return { stdout: `RESOLVED:198.18.0.1\nDENY_CONNECTED\n${REDIRECT_PROBE_MARKER}\n`, stderr: '' }
      }
      return happyResponses(file, args)
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    expect(ok).toBe(false)
    expect(byName(results, 'lockdown')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('reached kube-dns tcp/53') as string,
    })
  })

  it('fails the dns-stub gate when resolution does not return the dummy IP', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-redirect') {
        // NXDOMAIN from a real resolver: the 53 REDIRECT lost to the CIDR
        // RETURN and the query escaped to kube-dns.
        return { stdout: `RESOLVED:ENOTFOUND\nDENY_FAST\n${REDIRECT_PROBE_MARKER}\n`, stderr: '' }
      }
      return happyResponses(file, args)
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    expect(ok).toBe(false)
    const stub = byName(results, 'dns-stub')
    expect(stub).toMatchObject({ status: 'fail' })
    expect(stub?.detail).toContain('ENOTFOUND')
  })

  it('runs the nested-mount probe under the exact nested session securityContext', async () => {
    const deps = makeDeps()
    const { results } = await runClusterCheck(deps)
    expect(byName(results, 'nested-mount')).toMatchObject({ status: 'pass' })

    const probePod = vi.mocked(deps.apply).mock.calls
      .map((c) => c[0] as { kind: string; metadata?: { name?: string } })
      .find((m) => m.kind === 'Pod' && m.metadata?.name === 'yaac-cluster-check-nested') as {
      spec: {
        hostUsers: boolean
        securityContext: { seccompProfile: { type: string } }
        containers: Array<{
          securityContext?: Record<string, unknown>
          command: string[]
        }>
      }
    } | undefined
    expect(probePod).toBeDefined()
    // The probe mirrors the nested session pod: userns + RuntimeDefault +
    // the session uid carrying a userns-scoped SYS_ADMIN grant.
    expect(probePod?.spec.hostUsers).toBe(false)
    expect(probePod?.spec.securityContext).toEqual({
      seccompProfile: { type: 'RuntimeDefault' },
    })
    expect(probePod?.spec.containers[0].securityContext).toEqual({
      runAsUser: sessionUid(),
      capabilities: { add: ['SYS_ADMIN'] },
      allowPrivilegeEscalation: true,
    })
    // The rootless-podman prerequisite: tmpfs mount inside an unprivileged
    // user namespace.
    expect(probePod?.spec.containers[0].command.join(' ')).toContain('unshare -U -r -m')
    expect(probePod?.spec.containers[0].command.join(' ')).toContain('mount -t tmpfs')
  })

  it('warns (without failing) when the userns mount is refused', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-nested') {
        return { stdout: 'NESTED_MOUNT_FAIL\n', stderr: '' }
      }
      return happyResponses(file, args)
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    const nested = byName(results, 'nested-mount')
    expect(nested).toMatchObject({ status: 'warn' })
    expect(nested?.fix).toContain('userns-scoped SYS_ADMIN grant')
    expect(ok).toBe(true) // warn-only — only nestedContainers sessions are affected
  })

  it('warns on proxy VIP pin drift and passes when the live Service matches', async () => {
    const drifted = happyRun()
    drifted.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'svc' && args[2] === 'yaac-proxy') {
        return { stdout: '10.96.200.7', stderr: '' }
      }
      // The netpol probe sees the same Service; its positive half rides
      // happyResponses' generic branches.
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-egress') {
        return { stdout: 'NP_BLOCKED\nNP_PROXY_OK\n', stderr: '' }
      }
      return happyResponses(file, args)
    })
    const driftedRun = await runClusterCheck(makeDeps({ run: drifted }))
    const warn = byName(driftedRun.results, 'proxy-vip')
    expect(warn).toMatchObject({ status: 'warn' })
    expect(warn?.detail).toContain(clusterIpForNamespace('test-ns'))
    expect(warn?.fix).toContain('Restart the yaac daemon')
    expect(driftedRun.ok).toBe(true) // warn-only, like CIDR drift

    const pinned = happyRun()
    pinned.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'svc' && args[2] === 'yaac-proxy') {
        return { stdout: clusterIpForNamespace('test-ns'), stderr: '' }
      }
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-egress') {
        return { stdout: 'NP_BLOCKED\nNP_PROXY_OK\n', stderr: '' }
      }
      return happyResponses(file, args)
    })
    const pinnedRun = await runClusterCheck(makeDeps({ run: pinned }))
    expect(byName(pinnedRun.results, 'proxy-vip')).toMatchObject({ status: 'pass' })
  })

  it('fails the redirect probe when the REDIRECT does not deliver to the relay', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-redirect') {
        // Probe succeeded but logged no REDIRECT_OK line.
        return { stdout: '[relay] probe listening\n', stderr: '' }
      }
      return happyResponses(file, args)
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    expect(ok).toBe(false)
    const redirect = byName(results, 'redirect')
    expect(redirect).toMatchObject({ status: 'fail' })
    expect(redirect?.detail).toContain('did not deliver to the relay')
  })

  it('fails the redirect probe when the probe pod never succeeds', async () => {
    mockGetJson.mockImplementation((args: string[]) => {
      if (args[1] === 'pod' && args[2] === 'yaac-cluster-check-redirect') {
        return Promise.resolve({ status: { phase: 'Failed' } })
      }
      return Promise.resolve(happyGetJson(args))
    })
    const { ok, results } = await runClusterCheck(makeDeps())
    expect(ok).toBe(false)
    const redirect = byName(results, 'redirect')
    expect(redirect).toMatchObject({ status: 'fail' })
    expect(redirect?.detail).toContain('phase Failed')
  })

  it('warns on service-subnet drift between the live cluster and the compiled VIP-pin range', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'configmap' && args[2] === 'kubeadm-config') {
        return {
          stdout: 'networking:\n  podSubnet: 10.244.0.0/16\n  serviceSubnet: 172.20.0.0/16\n',
          stderr: '',
        }
      }
      return happyResponses(file, args)
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    const cidr = byName(results, 'service-cidr')
    expect(cidr).toMatchObject({ status: 'warn' })
    expect(cidr?.detail).toContain('drift')
    expect(ok).toBe(true) // warn-only — drift alone must not hard-fail
  })

  it('ignores pod-subnet drift — nothing compiled depends on it', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'configmap' && args[2] === 'kubeadm-config') {
        return {
          stdout: 'networking:\n  podSubnet: 10.128.0.0/16\n  serviceSubnet: 10.96.0.0/16\n',
          stderr: '',
        }
      }
      return happyResponses(file, args)
    })
    const { results } = await runClusterCheck(makeDeps({ run }))
    expect(byName(results, 'service-cidr')).toMatchObject({ status: 'pass' })
  })

  it('fails the registry check with start instructions when nothing answers', async () => {
    const { ok, results } = await runClusterCheck(makeDeps({
      registryReachable: vi.fn().mockResolvedValue(false),
    }))
    expect(ok).toBe(false)
    const registry = byName(results, 'registry')
    expect(registry).toMatchObject({ status: 'fail' })
    expect(registry?.fix).toContain('podman run -d --name yaac-registry')
  })

  it('fails the probe with wiring hints when the pod ends in a non-Succeeded phase', async () => {
    mockGetJson.mockResolvedValue({ status: { phase: 'Failed' } })
    const { ok, results } = await runClusterCheck(makeDeps())
    expect(ok).toBe(false)
    const probe = byName(results, 'probe')
    expect(probe).toMatchObject({ status: 'fail' })
    expect(probe?.detail).toContain('phase Failed')
    expect(probe?.fix).toContain('ImagePullBackOff')
  })

  it('fails the probe when the pod write never reaches the host', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'nodes') {
        return { stdout: JSON.stringify({ items: [{}] }), stderr: '' }
      }
      // Probe logs return the right nonce, but the pod's write marker
      // never appears host-side (uid mismatch / read-only wiring).
      if (file === 'kubectl' && args[0] === 'logs') {
        const nonce = await fs.readFile(path.join(getDataDir(), '.cluster-check-nonce'), 'utf8')
        return { stdout: `${nonce}\n`, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    expect(ok).toBe(false)
    const probe = byName(results, 'probe')
    expect(probe).toMatchObject({ status: 'fail' })
    expect(probe?.detail).toContain('did not reach the host')
    expect(probe?.fix).toContain('uid')
  })

  it('fails the probe when the pod reads stale hostPath data', async () => {
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'nodes') {
        return Promise.resolve({ stdout: JSON.stringify({ items: [{}] }), stderr: '' })
      }
      if (file === 'kubectl' && args[0] === 'logs') {
        return Promise.resolve({ stdout: 'some-stale-nonce\n', stderr: '' })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    expect(ok).toBe(false)
    expect(byName(results, 'probe')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('stale data') as string,
    })
  })
})

describe('formatCheckResult', () => {
  it('renders pass/fail/warn/skip icons with name and detail', () => {
    expect(formatCheckResult({ name: 'kubectl', status: 'pass', detail: 'installed' }))
      .toBe('✓ kubectl: installed')
    expect(formatCheckResult({ name: 'registry', status: 'fail', detail: 'down' }))
      .toBe('✗ registry: down')
    expect(formatCheckResult({ name: 'nodes', status: 'warn', detail: '2 nodes' }))
      .toBe('! nodes: 2 nodes')
    expect(formatCheckResult({ name: 'probe', status: 'skip', detail: 'skipped' }))
      .toBe('- probe: skipped')
  })

  it('appends indented fix lines for failures', () => {
    const rendered = formatCheckResult({
      name: 'registry',
      status: 'fail',
      detail: 'nothing answering',
      fix: 'line one\nline two',
    })
    expect(rendered).toBe(
      '✗ registry: nothing answering\n    fix: line one\n         line two',
    )
  })

  it('renders the fix for warnings too, but never for pass/skip', () => {
    expect(formatCheckResult({ name: 'nodes', status: 'warn', detail: 'x', fix: 'use one node' }))
      .toContain('fix: use one node')
    expect(formatCheckResult({ name: 'ok', status: 'pass', detail: 'x', fix: 'irrelevant' }))
      .toBe('✓ ok: x')
    expect(formatCheckResult({ name: 'probe', status: 'skip', detail: 'x', fix: 'irrelevant' }))
      .toBe('- probe: x')
  })
})
