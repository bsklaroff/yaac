import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

vi.mock('#features/cluster/cluster-cidrs', () => ({
  nodeIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
  apiserverIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
  resetClusterCidrCache: vi.fn(),
}))

vi.mock('#platform/k8s/kubectl', () => ({
  execFileAsync: vi.fn(),
  k8sNamespace: vi.fn(() => 'test-ns'),
  kubectlApply: vi.fn(),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn(),
}))

import {
  formatCheckResult,
  netdNotReadyContainers,
  runClusterCheck,
  type ClusterCheckDeps,
} from '#features/cluster/check'
import type { CheckResult } from '@yaac/shared/types'
import { kubectlGetJson, kubectlWithRetry } from '#platform/k8s/kubectl'
import {
  armDeferredClusterBoot,
  _resetDeferredClusterBootForTests,
} from '#platform/k8s/deferred-boot'
import { sessionUid } from '#features/images/image-builder'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@yaac/test-utils/setup'

const mockGetJson = vi.mocked(kubectlGetJson)
// The vap check probes through vapAvailable() (vcluster.ts), which runs on
// kubectlWithRetry rather than deps.run.
const mockRetry = vi.mocked(kubectlWithRetry)

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
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'nodes'
    && args.includes('jsonpath={.items[*].metadata.name}')) {
    return { stdout: 'yaac-control-plane', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'nodes') {
    return { stdout: JSON.stringify({ items: [{}] }), stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'runtimeclass') {
    return { stdout: 'gvisor gvisor-nested runc', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-gvisor') {
    return { stdout: 'GVISOR_SANDBOXED\n', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'pods') {
    // runtime-stamp sweep (-A): every untrusted (session-labeled / synced)
    // pod is gvisor-sandboxed; unstamped infra (the proxy) is fine, and
    // kube-system pods are out of scope by namespace.
    return {
      stdout: JSON.stringify({
        items: [
          {
            metadata: {
              name: 'yaac-session-abc', namespace: 'test-ns',
              labels: { 'yaac.session-id': 'abc' },
            },
            spec: { runtimeClassName: 'gvisor' },
          },
          { metadata: { name: 'yaac-proxy-abc', namespace: 'test-ns' }, spec: {} },
          { metadata: { name: 'coredns-xyz', namespace: 'kube-system' }, spec: {} },
        ],
      }),
      stderr: '',
    }
  }
  if (file === 'podman' && args[0] === 'exec') {
    return { stdout: 'tasksmax=ok\nminfree=262144\nhk=ok\n', stderr: '' }
  }
  if (file === 'podman' && args[0] === 'inspect') {
    return { stdout: '32768\n', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'svc' && args[2] === 'kubernetes') {
    return { stdout: '10.96.0.1', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'svc' && args[2] === 'kube-dns') {
    return { stdout: '10.96.0.10', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-egress') {
    return { stdout: 'NP_BLOCKED\n', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'daemonset') {
    // Both datapath DaemonSets report fully rolled out.
    return { stdout: '1/1', stderr: '' }
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
    // vapAvailable()'s kubectl probe answers unless a test overrides.
    mockRetry.mockReset()
    mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
    _resetDeferredClusterBootForTests()
  })

  it('reports ready without probing while a deferred cluster attach is pending', async () => {
    // A nested server that armed its cluster boot fronts an asleep
    // (scale-to-zero) vcluster — the check must not wake it or time out.
    armDeferredClusterBoot(async () => { /* never fired in this test */ })
    const deps = makeDeps()

    const { ok, results } = await runClusterCheck(deps)

    expect(ok).toBe(true)
    expect(results.map((r) => [r.name, r.status])).toEqual([['cluster', 'pass']])
    // No probing: not a single kubectl/podman call, no probe pod applied.
    expect(deps.run).not.toHaveBeenCalled()
    expect(deps.apply).not.toHaveBeenCalled()
    expect(deps.pushImage).not.toHaveBeenCalled()
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
      ['node-fixups', 'pass'],
      ['gvisor', 'pass'],
      ['probe', 'pass'],
      ['egress', 'pass'],
      ['datapath', 'pass'],
      ['nested-mount', 'pass'],
      ['vap', 'pass'],
      ['runtime-stamp', 'pass'],
    ])
    expect(ok).toBe(true)
    expect(byName(results, 'datapath')?.detail).toContain('calico-node and yaac-netd ready')

    // Probe ran through the deps: image pushed, pod applied, pod deleted.
    expect(deps.pushImage).toHaveBeenCalledWith('yaac-cluster-probe:busybox-1.36')
    const probePod = vi.mocked(deps.apply).mock.calls
      .map((c) => c[0] as { kind: string; metadata?: { name?: string } })
      .find((m) => m.kind === 'Pod' && m.metadata?.name === 'yaac-cluster-check')
    expect(probePod).toBeDefined()
    const podManifest = probePod as {
      kind: string
      spec: {
        hostUsers?: boolean
        runtimeClassName?: string
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
    // The probe mirrors the session-pod containment: the default gvisor
    // tier with no user namespace (the sentry replaces it).
    expect(podManifest.spec.runtimeClassName).toBe('gvisor')
    expect(podManifest.spec.hostUsers).toBeUndefined()
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

  it('skips the egress-layer and vcluster gates inside a nested yaac', async () => {
    process.env.YAAC_NESTED = '1'
    try {
      const deps = makeDeps()
      const { ok, results } = await runClusterCheck(deps)
      expect(ok).toBe(true)
      // The shared-machinery checks still run for real (inner registry,
      // inner namespace, inner probe).
      expect(byName(results, 'probe')?.status).toBe('pass')
      // egress is enforced host-side for a vcluster's synced pods (not
      // probeable from in here), so it self-skips along with the rest.
      // node-fixups likewise: there is no podman-hosted node in here, and
      // the gvisor runtime is the host cluster's concern.
      for (const name of ['node-fixups', 'gvisor', 'egress', 'nested-mount', 'vap', 'runtime-stamp']) {
        expect(byName(results, name)?.status).toBe('skip')
      }
      // datapath IS checked nested, in this install's own terms: its
      // claim-mode netd must be publishing, or the host leaves its sessions
      // on the outer proxy's allowlist alone.
      expect(byName(results, 'datapath')?.status).toBe('pass')
      expect(byName(results, 'datapath')?.detail).toContain('claim mode')
      // The relay IS probed nested (the inner proxy's pod IP): with no
      // inner proxy pod in the fake listing it degrades to a warn, never
      // a fail.
      expect(byName(results, 'relay')?.status).toBe('warn')
    } finally {
      delete process.env.YAAC_NESTED
    }
  })

  it('warns rather than fails when the nested claim-mode netd is not deployed yet', async () => {
    // A preflight in a fresh nested install finds nothing: netd lands with
    // the inner proxy on first session create.
    process.env.YAAC_NESTED = '1'
    try {
      const run = happyRun()
      run.mockImplementation(async (file: string, args: string[]) => {
        if (file === 'kubectl' && args[0] === 'get' && args[1] === 'daemonset'
          && args[2] === 'yaac-netd') {
          throw new Error('daemonsets.apps "yaac-netd" not found')
        }
        return happyResponses(file, args)
      })
      const { ok, results } = await runClusterCheck(makeDeps({ run }))
      expect(ok).toBe(true)
      expect(byName(results, 'datapath')?.status).toBe('warn')
    } finally {
      delete process.env.YAAC_NESTED
    }
  })

  it('fails the nested datapath gate when a deployed claim-mode netd is not ready', async () => {
    process.env.YAAC_NESTED = '1'
    try {
      const run = happyRun()
      run.mockImplementation(async (file: string, args: string[]) => {
        if (file === 'kubectl' && args[0] === 'get' && args[1] === 'daemonset'
          && args[2] === 'yaac-netd') {
          return { stdout: '0/1', stderr: '' }
        }
        return happyResponses(file, args)
      })
      const { ok, results } = await runClusterCheck(makeDeps({ run }))
      expect(ok).toBe(false)
      const datapath = byName(results, 'datapath')
      expect(datapath?.status).toBe('fail')
      expect(datapath?.detail).toContain('OUTER proxy')
    } finally {
      delete process.env.YAAC_NESTED
    }
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
    expect(byName(results, 'node-fixups')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'probe')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'egress')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'datapath')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'nested-mount')).toMatchObject({ status: 'skip' })
    expect(deps.pushImage).not.toHaveBeenCalled()
    expect(deps.apply).not.toHaveBeenCalled()
  })

  it('warns on node-fixups (pointing at setup --repair) when a fixup went missing', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'podman' && args[0] === 'exec') {
        // Node restarted: the TasksMax conf is gone and the sysctl is back
        // at its tiny default; a pre-fixup node also lacks the kubelet
        // housekeeping flag.
        return { stdout: 'tasksmax=missing\nminfree=67584\nhk=missing\n', stderr: '' }
      }
      if (file === 'podman' && args[0] === 'inspect') {
        return { stdout: '2048\n', stderr: '' } // podman's default pids ceiling
      }
      return happyResponses(file, args)
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    const fixups = byName(results, 'node-fixups')
    expect(fixups).toMatchObject({ status: 'warn' })
    expect(fixups?.detail).toContain('DefaultTasksMax')
    expect(fixups?.detail).toContain('vm.min_free_kbytes')
    expect(fixups?.detail).toContain('kubelet housekeeping-interval')
    expect(fixups?.detail).toContain('pids-limit')
    expect(fixups?.fix).toContain('yaac cluster setup --repair')
    expect(ok).toBe(true) // warn-only: these fixups fail late, not at pod start
  })

  it('skips node-fixups when the node is not a podman container (non-kind backend)', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'podman' && args[0] === 'exec') {
        return Promise.reject(new Error('no such container'))
      }
      return happyResponses(file, args)
    })
    const { results } = await runClusterCheck(makeDeps({ run }))
    const fixups = byName(results, 'node-fixups')
    expect(fixups).toMatchObject({ status: 'skip' })
    expect(fixups?.detail).toContain('not a podman container')
  })

  it('fails gvisor (and skips the probes) when a RuntimeClass is missing', async () => {
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'runtimeclass') {
        return Promise.resolve({ stdout: 'runc', stderr: '' })
      }
      return happyResponses(file, args)
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    expect(ok).toBe(false)
    const gvisor = byName(results, 'gvisor')
    expect(gvisor).toMatchObject({ status: 'fail' })
    expect(gvisor?.detail).toContain('gvisor-nested')
    expect(gvisor?.fix).toContain('yaac cluster setup --repair')
    // A gvisor pod would sit Pending to its timeout — the probes skip.
    expect(byName(results, 'probe')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'egress')).toMatchObject({ status: 'skip' })
  })

  it('fails gvisor when a pod on the gvisor class is not sentry-sandboxed', async () => {
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-gvisor') {
        // The handler silently ran the pod on runc: the node kernel's
        // ring buffer has no sentry boot messages.
        return Promise.resolve({ stdout: 'GVISOR_NOT_SANDBOXED\n', stderr: '' })
      }
      return happyResponses(file, args)
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    expect(ok).toBe(false)
    expect(byName(results, 'gvisor')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('not sentry-sandboxed') as string,
    })
  })

  it('warns (without failing) on runtime-stamp when an untrusted pod is not gvisor-sandboxed', async () => {
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'pods') {
        return Promise.resolve({
          stdout: JSON.stringify({
            items: [
              // Unstamped infra is deliberate (runc) — never flagged.
              { metadata: { name: 'yaac-proxy-abc', namespace: 'test-ns' }, spec: {} },
              // A session pod without the gvisor tier is the violation.
              {
                metadata: {
                  name: 'yaac-old-session', namespace: 'test-ns',
                  labels: { 'yaac.session-id': 'old' },
                },
                spec: {},
              },
              // The vcluster child namespaces are in scope — synced tenant
              // pods (syncer-labeled) rely on the values.yaml knob for
              // their stamp, i.e. the likeliest invariant violation.
              {
                metadata: {
                  name: 'coredns-tenant', namespace: 'test-ns-vc-abcd1234',
                  labels: { 'vcluster.loft.sh/managed-by': 'yvc-abcd1234' },
                },
                spec: {},
              },
              // The vcluster control plane is trusted infra: unstamped, unlabeled, unflagged.
              { metadata: { name: 'yvc-abcd1234-0', namespace: 'test-ns-vc-abcd1234' }, spec: {} },
              // Other namespaces are not yaac's to police.
              { metadata: { name: 'coredns-xyz', namespace: 'kube-system' }, spec: {} },
            ],
          }),
          stderr: '',
        })
      }
      return happyResponses(file, args)
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    const stamp = byName(results, 'runtime-stamp')
    expect(stamp).toMatchObject({ status: 'warn' })
    expect(stamp?.detail).toContain('test-ns/yaac-old-session')
    expect(stamp?.detail).toContain('test-ns-vc-abcd1234/coredns-tenant')
    expect(stamp?.detail).not.toContain('yaac-proxy-abc')
    expect(stamp?.detail).not.toContain('yvc-abcd1234-0')
    expect(stamp?.detail).not.toContain('kube-system')
    expect(ok).toBe(true) // warn-only: unsandboxed pods keep running
  })

  it('passes the egress check when a session-labeled pod cannot reach the apiserver', async () => {
    const { results } = await runClusterCheck(makeDeps())
    expect(byName(results, 'egress')).toMatchObject({
      status: 'pass',
      detail: expect.stringContaining('default-denied at the CNI') as string,
    })
  })

  it('fails the egress check when the CNI does not enforce NetworkPolicy', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-egress') {
        // Policy not enforced: the probe reached the apiserver.
        return { stdout: 'NP_REACHED\n', stderr: '' }
      }
      return happyResponses(file, args)
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    expect(ok).toBe(false)
    const egress = byName(results, 'egress')
    expect(egress).toMatchObject({ status: 'fail' })
    expect(egress?.detail).toContain('not enforcing NetworkPolicy')
    expect(egress?.fix).toContain('Calico')
  })

  it('fails the egress check when a session pod can dial a transparent port (forgery lock open)', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'svc' && args[2] === 'yaac-proxy') {
        return { stdout: '10.96.7.7', stderr: '' }
      }
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-egress') {
        // Blocked from the apiserver, but reached a transparent port directly.
        return { stdout: 'NP_BLOCKED\nNP_PROXY_OPEN\n', stderr: '' }
      }
      return happyResponses(file, args)
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    expect(ok).toBe(false)
    const egress = byName(results, 'egress')
    expect(egress).toMatchObject({ status: 'fail' })
    expect(egress?.detail).toContain('forgery lock is open')
  })

  it('passes datapath when calico-node and netd are both rolled out', async () => {
    const { results } = await runClusterCheck(makeDeps())
    expect(byName(results, 'datapath')).toMatchObject({
      status: 'pass',
      detail: expect.stringContaining('policy enforced, egress redirected') as string,
    })
  })

  it('fails datapath when calico-node is not ready (policy unenforced)', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'daemonset'
        && args[2] === 'calico-node') {
        return { stdout: '0/1', stderr: '' }
      }
      return happyResponses(file, args)
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    expect(ok).toBe(false)
    const datapath = byName(results, 'datapath')
    expect(datapath).toMatchObject({ status: 'fail' })
    expect(datapath?.detail).toContain('NetworkPolicy is not being enforced')
  })

  it('names the unhealthy netd container when the DaemonSet is not ready', async () => {
    // netd's readiness IS Envoy's config ack, so a broken sidecar and a
    // broken netd are indistinguishable from the DaemonSet counters alone.
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'daemonset'
        && args[2] === 'yaac-netd') {
        return { stdout: '0/1', stderr: '' }
      }
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'pods'
        && args.includes('app=yaac-netd')) {
        return {
          stdout: JSON.stringify({
            items: [{
              status: {
                containerStatuses: [
                  { name: 'netd', ready: false },
                  { name: 'envoy', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } },
                ],
              },
            }],
          }),
          stderr: '',
        }
      }
      return happyResponses(file, args)
    })
    const { results } = await runClusterCheck(makeDeps({ run }))
    const datapath = byName(results, 'datapath')
    expect(datapath).toMatchObject({ status: 'fail' })
    expect(datapath?.detail).toContain('envoy: CrashLoopBackOff')
    expect(datapath?.fix).toContain('-c envoy')
  })

  it('fails datapath when netd is absent (session egress has no redirect)', async () => {
    // Fail-CLOSED, unlike a missing Calico: sessions lose egress rather
    // than gaining unrestricted egress. The two are reported distinctly
    // because the operator response differs.
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'daemonset'
        && args[2] === 'yaac-netd') {
        throw new Error('daemonsets.apps "yaac-netd" not found')
      }
      return happyResponses(file, args)
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    expect(ok).toBe(false)
    const datapath = byName(results, 'datapath')
    expect(datapath).toMatchObject({ status: 'fail' })
    expect(datapath?.detail).toContain('not deployed')
  })

  it('runs the nested-mount probe under the exact nested session securityContext', async () => {
    const deps = makeDeps()
    const { results } = await runClusterCheck(deps)
    expect(byName(results, 'nested-mount')).toMatchObject({ status: 'pass' })

    const probePod = vi.mocked(deps.apply).mock.calls
      .map((c) => c[0] as { kind: string; metadata?: { name?: string } })
      .find((m) => m.kind === 'Pod' && m.metadata?.name === 'yaac-cluster-check-nested') as {
      spec: {
        hostUsers?: boolean
        runtimeClassName?: string
        securityContext: { seccompProfile: { type: string } }
        containers: Array<{
          securityContext?: Record<string, unknown>
          command: string[]
        }>
      }
    } | undefined
    expect(probePod).toBeDefined()
    // The probe mirrors the nested tier: gvisor-nested, no userns (the sentry
    // is the containment), in-sandbox root with the engine's caps.
    expect(probePod?.spec.runtimeClassName).toBe('gvisor-nested')
    expect(probePod?.spec.hostUsers).toBeUndefined()
    expect(probePod?.spec.securityContext).toEqual({
      seccompProfile: { type: 'RuntimeDefault' },
    })
    expect(probePod?.spec.containers[0].securityContext).toEqual({
      runAsUser: 0,
      capabilities: {
        add: [
          'SYS_ADMIN', 'SYS_CHROOT', 'MKNOD', 'SETFCAP',
          'NET_RAW', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_RESOURCE',
        ],
      },
    })
    // The core sentry prerequisite: in-sandbox root can mount a tmpfs.
    expect(probePod?.spec.containers[0].command.join(' ')).toContain('mount -t tmpfs')
  })

  it('warns (without failing) when the nested sentry mount fails', async () => {
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
    expect(nested?.fix).toContain('cluster setup --repair')
    expect(ok).toBe(true) // warn-only — only nestedContainers sessions are affected
  })

  it('warns (without failing) on vap when the ValidatingAdmissionPolicy API is unavailable', async () => {
    // The check gates on vapAvailable() — the exact probe session-create
    // applies — so it is stubbed at the kubectl layer, not deps.run.
    mockRetry.mockRejectedValue(new Error("the server doesn't have a resource type"))
    const { ok, results } = await runClusterCheck(makeDeps())
    const vap = byName(results, 'vap')
    expect(vap).toMatchObject({ status: 'warn' })
    expect(vap?.detail).toContain('ValidatingAdmissionPolicy API unavailable')
    expect(vap?.fix).toContain('virtualCluster')
    expect(ok).toBe(true) // warn-only — only virtualCluster sessions are affected
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
    // Only the e2e probe pod fails — the gvisor probe (a different pod
    // name) keeps succeeding so the probe is reached at all.
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve(
      args.includes('yaac-cluster-check')
        ? { status: { phase: 'Failed' } }
        : happyGetJson(args),
    ))
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
      // Probe logs return the right nonce, but the pod's write marker
      // never appears host-side (uid mismatch / read-only wiring).
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check') {
        const nonce = await fs.readFile(path.join(getDataDir(), '.cluster-check-nonce'), 'utf8')
        return { stdout: `${nonce}\n`, stderr: '' }
      }
      return happyResponses(file, args)
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
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check') {
        return Promise.resolve({ stdout: 'some-stale-nonce\n', stderr: '' })
      }
      return happyResponses(file, args)
    })
    const { ok, results } = await runClusterCheck(makeDeps({ run }))
    expect(ok).toBe(false)
    expect(byName(results, 'probe')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('stale data') as string,
    })
  })
})

describe('netdNotReadyContainers', () => {
  it('reports each not-ready container with its state reason', () => {
    expect(netdNotReadyContainers(JSON.stringify({
      items: [{
        status: {
          containerStatuses: [
            { name: 'netd', ready: true, state: { running: {} } },
            { name: 'envoy', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } },
          ],
        },
      }],
    }))).toEqual(['envoy: CrashLoopBackOff'])
  })

  it('falls back to a bare label and dedupes across pods', () => {
    const pod = { status: { containerStatuses: [{ name: 'netd', ready: false }] } }
    expect(netdNotReadyContainers(JSON.stringify({ items: [pod, pod] })))
      .toEqual(['netd: not ready'])
  })

  it('yields nothing for unparseable or empty input', () => {
    expect(netdNotReadyContainers('')).toEqual([])
    expect(netdNotReadyContainers('not json')).toEqual([])
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
