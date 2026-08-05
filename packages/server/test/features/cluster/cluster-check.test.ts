import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

vi.mock('#platform/k8s/kubectl', () => ({
  execFileAsync: vi.fn(),
  k8sNamespace: vi.fn(() => 'test-ns'),
  kubectlApply: vi.fn(),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn(),
}))

vi.mock('#platform/container/registry', () => ({
  registryReachable: vi.fn().mockResolvedValue(true),
  registryHost: vi.fn(() => 'localhost:5001'),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
  registryHasTag: vi.fn().mockResolvedValue(true),
  pushImageToRegistry: vi.fn().mockResolvedValue('localhost:5000/yaac-cluster-probe:busybox-1.36'),
}))

import { formatCheckResult, runClusterCheck } from '#features/cluster'
import type { CheckResult } from '@yaac/shared/types'
import { execFileAsync, kubectlApply, kubectlGetJson, kubectlWithRetry } from '#platform/k8s/kubectl'
import { pushImageToRegistry, registryReachable } from '#platform/container/registry'
import { resetClusterCidrCache } from '#features/cluster/cluster-cidrs'
import {
  armDeferredClusterBoot,
  _resetDeferredClusterBootForTests,
} from '#platform/k8s/deferred-boot'
import { sessionUid } from '#platform/k8s'
import { buildPriorityClassManifests } from '#platform/k8s'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@yaac/test-utils/setup'

const mockGetJson = vi.mocked(kubectlGetJson)
const mockRun = vi.mocked(execFileAsync)
const mockApply = vi.mocked(kubectlApply)
const mockPush = vi.mocked(pushImageToRegistry)
const mockReachable = vi.mocked(registryReachable)
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

interface LivePriorityClass {
  metadata: { name: string }
  value: number
  preemptionPolicy: string
}

/**
 * The installed PriorityClasses as the apiserver hands them back: same
 * objects `yaac cluster setup` applies, except that kubernetes materializes
 * the omitted preemptionPolicy into an explicit PreemptLowerPriority — the
 * asymmetry the check has to tolerate.
 */
function livePriorityClasses(): LivePriorityClass[] {
  return (buildPriorityClassManifests() as unknown as Array<{
    metadata: { name: string }
    value: number
    preemptionPolicy?: string
  }>).map((c) => ({
    metadata: { name: c.metadata.name },
    value: c.value,
    preemptionPolicy: c.preemptionPolicy ?? 'PreemptLowerPriority',
  }))
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
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'priorityclass') {
    return { stdout: JSON.stringify({ items: livePriorityClasses() }), stderr: '' }
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
function happyGetJson(args: string[]): unknown {
  // The node/apiserver reads the real cluster-cidrs probe makes for the
  // policies the egress check exercises.
  if (args[1] === 'nodes') {
    return { items: [{ status: { addresses: [{ type: 'InternalIP', address: '10.89.0.7' }] } }] }
  }
  if (args[1] === 'endpoints') return { subsets: [{ addresses: [{ ip: '10.89.0.7' }] }] }
  return { status: { phase: 'Succeeded' } }
}

interface Staged {
  run: RunMock
  apply: typeof mockApply
  pushImage: typeof mockPush
}

/**
 * Install the process-boundary fakes one check run needs — the subprocess
 * runner, the registry ping and push, and kubectl apply — and hand back the
 * call records the assertions read. `ensureNamespace` is a sibling and runs
 * for real, so its Namespace apply shows up in `apply`.
 */
function stage(overrides: { run?: RunMock; registryReachable?: boolean } = {}): Staged {
  const run = overrides.run ?? happyRun()
  mockRun.mockClear()
  mockApply.mockClear()
  mockPush.mockClear()
  mockRun.mockImplementation(run as never)
  mockReachable.mockResolvedValue(overrides.registryReachable ?? true)
  mockPush.mockResolvedValue('localhost:5000/yaac-cluster-probe:busybox-1.36')
  mockApply.mockResolvedValue(undefined)
  return { run, apply: mockApply, pushImage: mockPush }
}

function byName(results: CheckResult[], name: string): CheckResult | undefined {
  return results.find((r) => r.name === name)
}

describe('runClusterCheck', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    mockGetJson.mockReset()
    resetClusterCidrCache()
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
    const deps = stage()

    const { ok, results } = await runClusterCheck()

    expect(ok).toBe(true)
    expect(results.map((r) => [r.name, r.status])).toEqual([['cluster', 'pass']])
    // No probing: not a single kubectl/podman call, no probe pod applied.
    expect(deps.run).not.toHaveBeenCalled()
    expect(deps.apply).not.toHaveBeenCalled()
    expect(deps.pushImage).not.toHaveBeenCalled()
  })

  it('passes every check on a healthy single-node cluster', async () => {
    const deps = stage()
    const { ok, results } = await runClusterCheck()

    expect(results.map((r) => [r.name, r.status])).toEqual([
      ['kubectl', 'pass'],
      ['cluster', 'pass'],
      ['nodes', 'pass'],
      ['podman', 'pass'],
      ['registry', 'pass'],
      ['namespace', 'pass'],
      ['priority-classes', 'pass'],
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
      stage()
      const { ok, results } = await runClusterCheck()
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
      stage({ run })
      const { ok, results } = await runClusterCheck()
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
      stage({ run })
      const { ok, results } = await runClusterCheck()
      expect(ok).toBe(false)
      const datapath = byName(results, 'datapath')
      expect(datapath?.status).toBe('fail')
      expect(datapath?.detail).toContain('OUTER proxy')
    } finally {
      delete process.env.YAAC_NESTED
    }
  })

  it('warns rather than crashing when the node list cannot be read', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'nodes'
        && args.includes('json')) {
        throw new Error('connection refused')
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { results } = await runClusterCheck()
    // Node count is advisory (hostPath assumes one), so an unreadable list
    // must not fail the run.
    expect(byName(results, 'nodes')).toMatchObject({ status: 'warn' })
    expect(byName(results, 'nodes')?.detail).toMatch(/could not list nodes.*connection refused/)
  })

  it('fails the namespace check with a rights hint when the namespace cannot be created', async () => {
    stage()
    mockApply.mockRejectedValue(new Error('namespaces is forbidden'))
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    expect(byName(results, 'namespace')).toMatchObject({ status: 'fail' })
    expect(byName(results, 'namespace')?.detail).toMatch(/cannot create namespace.*forbidden/)
    expect(byName(results, 'namespace')?.fix).toMatch(/admin rights/)
  })

  it('short-circuits with a single failure when kubectl is missing', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'kubectl' && args.includes('--client')) {
        return Promise.reject(new Error('ENOENT: kubectl'))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    stage({ run })
    const { ok, results } = await runClusterCheck()

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
    stage({ run })
    const { ok, results } = await runClusterCheck()

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
    stage({ run })
    const { ok, results } = await runClusterCheck()

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
    const deps = stage({ run })
    const { ok, results } = await runClusterCheck()

    expect(ok).toBe(false)
    expect(byName(results, 'podman')).toMatchObject({ status: 'fail' })
    expect(byName(results, 'node-fixups')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'probe')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'egress')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'datapath')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'nested-mount')).toMatchObject({ status: 'skip' })
    expect(deps.pushImage).not.toHaveBeenCalled()
    // No probe object reached the cluster (the namespace ensure is a
    // sibling and may still have run).
    const appliedKinds = deps.apply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(appliedKinds).not.toContain('Pod')
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
    stage({ run })
    const { ok, results } = await runClusterCheck()
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
    stage({ run })
    const { results } = await runClusterCheck()
    const fixups = byName(results, 'node-fixups')
    expect(fixups).toMatchObject({ status: 'skip' })
    expect(fixups?.detail).toContain('not a podman container')
  })

  it('fails priority-classes (and skips the probes) when a class is missing', async () => {
    // The failure this names: the apiserver rejects a pod that references a
    // class it does not have, so a session Job applies and then hangs with
    // no pod — with nothing else in the check pointing at the cause.
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'priorityclass') {
        const items = livePriorityClasses().filter((c) => c.metadata.name !== 'yaac-session')
        return Promise.resolve({ stdout: JSON.stringify({ items }), stderr: '' })
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    const pcs = byName(results, 'priority-classes')
    expect(pcs).toMatchObject({ status: 'fail' })
    expect(pcs?.detail).toContain('yaac-session')
    expect(pcs?.fix).toContain('yaac cluster setup --repair')
    expect(byName(results, 'probe')).toMatchObject({ status: 'skip' })
  })

  it('warns (without failing) when an installed PriorityClass has drifted', async () => {
    // A class an older yaac installed with different numbers still lets
    // every pod schedule — it just ranks them wrong, so this is not fatal.
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'priorityclass') {
        const items = livePriorityClasses().map((c) =>
          c.metadata.name === 'yaac-infra' ? { ...c, value: 42 } : c)
        return Promise.resolve({ stdout: JSON.stringify({ items }), stderr: '' })
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(true)
    const pcs = byName(results, 'priority-classes')
    expect(pcs).toMatchObject({ status: 'warn' })
    expect(pcs?.detail).toContain('yaac-infra')
    // Warn-only: the rest of the suite still runs.
    expect(byName(results, 'probe')).toMatchObject({ status: 'pass' })
  })

  it('fails gvisor (and skips the probes) when a RuntimeClass is missing', async () => {
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'runtimeclass') {
        return Promise.resolve({ stdout: 'runc', stderr: '' })
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
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
    stage({ run })
    const { ok, results } = await runClusterCheck()
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
    stage({ run })
    const { ok, results } = await runClusterCheck()
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
    stage()
    const { results } = await runClusterCheck()
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
    stage({ run })
    const { ok, results } = await runClusterCheck()
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
    stage({ run })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    const egress = byName(results, 'egress')
    expect(egress).toMatchObject({ status: 'fail' })
    expect(egress?.detail).toContain('forgery lock is open')
  })

  it('passes datapath when calico-node and netd are both rolled out', async () => {
    stage()
    const { results } = await runClusterCheck()
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
    stage({ run })
    const { ok, results } = await runClusterCheck()
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
    stage({ run })
    const { results } = await runClusterCheck()
    const datapath = byName(results, 'datapath')
    expect(datapath).toMatchObject({ status: 'fail' })
    expect(datapath?.detail).toContain('envoy: CrashLoopBackOff')
    expect(datapath?.fix).toContain('-c envoy')
  })

  it('dedupes the unhealthy netd containers and tolerates unreadable pod JSON', async () => {
    const withPods = async (podsStdout: string): Promise<string> => {
      const run = happyRun()
      run.mockImplementation(async (file: string, args: string[]) => {
        if (file === 'kubectl' && args[0] === 'get' && args[1] === 'daemonset'
          && args[2] === 'yaac-netd') {
          return { stdout: '0/1', stderr: '' }
        }
        if (file === 'kubectl' && args[0] === 'get' && args[1] === 'pods'
          && args.includes('app=yaac-netd')) {
          return { stdout: podsStdout, stderr: '' }
        }
        return happyResponses(file, args)
      })
      stage({ run })
      const { results } = await runClusterCheck()
      return byName(results, 'datapath')?.detail ?? ''
    }

    // One name per fault, however many pods carry it: a 50-node DaemonSet
    // must not print the same crashing sidecar fifty times. Ready and
    // nameless containers are not faults at all.
    const pod = {
      status: {
        containerStatuses: [
          { name: 'envoy', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } },
          { name: 'netd', ready: true },
          { ready: false },
        ],
      },
    }
    const detail = await withPods(JSON.stringify({ items: [pod, pod] }))
    expect(detail.match(/envoy: CrashLoopBackOff/g)).toHaveLength(1)
    expect(detail).not.toContain('netd: ')

    // A container down with no state at all still gets named.
    expect(await withPods(JSON.stringify({
      items: [{ status: { containerStatuses: [{ name: 'netd', ready: false }] } }],
    }))).toContain('netd: not ready')

    // Unreadable output must not mask the real failure with a crash.
    for (const junk of ['', 'not json', '{}']) {
      const d = await withPods(junk)
      expect(d).toContain('session egress has no redirect')
      expect(d).not.toContain('(')
    }
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
    stage({ run })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    const datapath = byName(results, 'datapath')
    expect(datapath).toMatchObject({ status: 'fail' })
    expect(datapath?.detail).toContain('not deployed')
  })

  it('runs the nested-mount probe under the exact nested session securityContext', async () => {
    const deps = stage()
    const { results } = await runClusterCheck()
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
    stage({ run })
    const { ok, results } = await runClusterCheck()
    const nested = byName(results, 'nested-mount')
    expect(nested).toMatchObject({ status: 'warn' })
    expect(nested?.fix).toContain('cluster setup --repair')
    expect(ok).toBe(true) // warn-only — only nestedContainers sessions are affected
  })

  it('warns (without failing) on vap when the ValidatingAdmissionPolicy API is unavailable', async () => {
    // The check gates on vapAvailable() — the exact probe session-create
    // applies — so it is stubbed at the kubectl layer, not deps.run.
    mockRetry.mockRejectedValue(new Error("the server doesn't have a resource type"))
    stage()
    const { ok, results } = await runClusterCheck()
    const vap = byName(results, 'vap')
    expect(vap).toMatchObject({ status: 'warn' })
    expect(vap?.detail).toContain('ValidatingAdmissionPolicy API unavailable')
    expect(vap?.fix).toContain('virtualCluster')
    expect(ok).toBe(true) // warn-only — only virtualCluster sessions are affected
  })

  it('fails the registry check with start instructions when nothing answers', async () => {
    stage({
      registryReachable: false,
    })
    const { ok, results } = await runClusterCheck()
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
    stage()
    const { ok, results } = await runClusterCheck()
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
    stage({ run })
    const { ok, results } = await runClusterCheck()
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
    stage({ run })
    const { ok, results } = await runClusterCheck()
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
