import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

// kubectl is the process boundary: the sweep is a sequence of deletes, so
// what it names and how it scopes them IS the behavior under test.
const mockRetry = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'test-ns',
  dataDirHash: () => 'ddh0123456789abc',
  kubectlWithRetry: mockRetry,
}))

import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'
import { sweepLegacyVclusterState } from '#drivers/k8s/cluster'
import { worktreeStateDir } from '@yaac/shared/project-paths'

let tmpDir: string

/** Every kubectl argv the sweep issued, one string apiece. */
const issued = (): string[] =>
  mockRetry.mock.calls.map((c) => (c[0] as string[]).join(' '))

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockRetry.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

describe('sweepLegacyVclusterState', () => {
  it('deletes this install\'s vcluster objects, scoped by its data-dir hash', async () => {
    await sweepLegacyVclusterState()
    const scope = '-l yaac.vcluster,yaac.vcluster-data-dir-hash=ddh0123456789abc'

    // The namespaces carry the control planes, synced pods, per-vcluster
    // policies, kubeconfig secrets and sleep slices with them.
    expect(issued()).toContainEqual(
      `delete namespace ${scope} --ignore-not-found --wait=false`)
    // Cluster-scoped leftovers outlive their namespace and nothing else
    // would ever collect them.
    expect(issued().find((c) => c.includes('validatingadmissionpolicies')))
      .toContain(scope)
    expect(issued()).toContainEqual(
      `delete networkpolicy -n test-ns ${scope} --ignore-not-found --wait=false`)

    // The scoping is the point: a second install's vclusters on a shared
    // cluster carry a different hash, and an unscoped delete would take
    // out worktrees this install has no business touching.
    for (const argv of issued()) {
      if (argv.includes('-l ')) expect(argv).toContain('ddh0123456789abc')
    }
  })

  it('deletes the singletons that carry no selectable label, by name', async () => {
    await sweepLegacyVclusterState()
    // The wake activator: one Deployment/SA/NetworkPolicy in the install
    // namespace, plus the per-vcluster Role/RoleBinding.
    expect(issued().find((c) => c.includes('yaac-vc-activator')))
      .toContain('--ignore-not-found')
    // The redirect-claim document the server republished for netd.
    expect(issued()).toContainEqual(
      'delete configmap yaac-redirect-claims -n test-ns --ignore-not-found --wait=false')
  })

  it('removes the on-disk kubeconfig and inner data dirs, leaving the worktree', async () => {
    const state = worktreeStateDir('demo', 'wt-1')
    await fs.mkdir(path.join(state, 'vcluster'), { recursive: true })
    await fs.mkdir(path.join(state, 'nested-yaac', 'projects'), { recursive: true })
    await fs.mkdir(path.join(state, 'skills'), { recursive: true })
    await fs.writeFile(path.join(state, 'vcluster', 'config'), 'kubeconfig\n')

    await sweepLegacyVclusterState()

    const exists = (p: string): Promise<boolean> =>
      fs.access(p).then(() => true, () => false)
    expect(await exists(path.join(state, 'vcluster'))).toBe(false)
    expect(await exists(path.join(state, 'nested-yaac'))).toBe(false)
    // Everything else the worktree keeps under its state dir survives —
    // the worktree goes on running, it just loses its nested cluster.
    expect(await exists(path.join(state, 'skills'))).toBe(true)
  })

  it('is a no-op it can repeat: nothing to delete still resolves', async () => {
    // Idempotent by construction (`--ignore-not-found`), which is what lets
    // it run on every attach for the rest of the shim's life.
    await expect(sweepLegacyVclusterState()).resolves.toBeUndefined()
    await expect(sweepLegacyVclusterState()).resolves.toBeUndefined()
  })

  it('survives an unreachable cluster — the next attach sweeps again', async () => {
    mockRetry.mockRejectedValue(new Error('connection refused'))
    await expect(sweepLegacyVclusterState()).resolves.toBeUndefined()
  })
})
