import { afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { globalRoot } from '@yaac/shared/paths'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import { BUILDER_MIRROR_TAG } from '#drivers/k8s/cluster/builder-image'
import { fakeRegistry } from './fake-registry'

/**
 * The cluster's side of the k8s root remover (`removeAsRoot`) in unit
 * tests. Each pod the code applies ends in its given phase at once; one
 * that succeeds first does its work, running its own script against the
 * directory its subPath names, after making the named entries writable as
 * root would find them.
 */

interface RootPod {
  spec: {
    containers: Array<{
      command: string[]
      securityContext: { runAsUser: number }
      volumeMounts: Array<{ mountPath: string; subPath: string }>
    }>
  }
}

afterEach(() => { vi.unstubAllEnvs() })

/** Make the pods applied from now on end in `phases`, in order, the last
 *  one repeating. */
export function podsRunAsRoot(...phases: Array<'Succeeded' | 'Failed'>): void {
  // The pods run the mirrored builder image.
  fakeRegistry.install()
  fakeRegistry.mirror(BUILDER_MIRROR_TAG)
  fakeCluster.intercept((c) => {
    if (c.verb !== 'apply' || c.kind !== 'Pod') return
    const phase = phases.length > 1 ? phases.shift() : phases[0]
    if (phase === 'Succeeded') {
      const [container] = (c.body as unknown as RootPod).spec.containers
      const [{ mountPath, subPath }] = container.volumeMounts
      const dir = path.join(globalRoot(), subPath)
      const [, , script, , ...names] = container.command
      execFileSync('chmod', ['-R', 'u+w', ...names.map((n) => path.join(dir, n))])
      execFileSync('sh', ['-c', script.replace(mountPath, dir), '--', ...names])
    }
    c.body = { ...c.body, status: { phase } }
  })
}

/** What each applied pod removed: its mount's subPath, its argv and its uid. */
export function appliedRootPods(): Array<{ subPath: string; names: string[]; runAsUser: number }> {
  return fakeCluster.callsOf('apply', 'Pod').map((c) => {
    const [container] = (c.body as unknown as RootPod).spec.containers
    return {
      subPath: container.volumeMounts[0].subPath,
      names: container.command.slice(4),
      runAsUser: container.securityContext.runAsUser,
    }
  })
}
