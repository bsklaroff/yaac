/**
 * The root remover's refusals and its pod. What it removes through
 * `deleteWorkspace` and project removal is covered in those tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { removeAsRoot } from '#drivers/k8s/workspaces'
import { GLOBAL_CLAIM_NAME, installId, k8sNamespace } from '#drivers/k8s/substrate'
import { appliedRootPods, podsRunAsRoot } from '#test/support/root-pods'
import { getProjectsDir, globalRoot } from '@yaac/shared/paths'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'

interface PodManifest {
  metadata: { namespace: string }
  spec: {
    runtimeClassName?: string
    volumes: Array<{ persistentVolumeClaim?: { claimName: string } }>
  }
}

let tmpDir: string
let project: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  project = path.join(getProjectsDir(), 'p1')
  await fs.mkdir(path.join(project, 'workspaces', 'w1', 'rootdir'), { recursive: true })
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

describe('removeAsRoot', () => {
  it('removes only the named entries, from a runc pod mounting just their directory', async () => {
    podsRunAsRoot('Succeeded')
    await fs.writeFile(path.join(project, 'keep'), 'x')
    await expect(removeAsRoot(project, ['workspaces'])).resolves.toBe(true)

    expect(await fs.readdir(project)).toEqual(['keep'])
    expect(appliedRootPods()).toEqual([{ subPath: 'projects/p1', names: ['workspaces'], runAsUser: 0 }])
    const [pod] = fakeCluster.callsOf('apply', 'Pod').map((c) => c.body as unknown as PodManifest)
    expect(pod.metadata.namespace).toBe(k8sNamespace())
    expect(pod.spec.runtimeClassName).toBeUndefined()
    expect(pod.spec.volumes).toEqual([{ name: 'global', persistentVolumeClaim: { claimName: GLOBAL_CLAIM_NAME } }])
    // The pod is gone once it has run.
    expect(fakeCluster.objects('Pod')).toEqual([])
  })

  it('refuses, running no pod, anything but plain entries of a real directory inside the global root', async () => {
    podsRunAsRoot('Succeeded')
    await fs.symlink(project, path.join(getProjectsDir(), 'linked'))
    const refusals: Array<[string, string[]]> = [
      [globalRoot(), ['projects']],
      [path.dirname(globalRoot()), ['global']],
      [path.join(getProjectsDir(), 'linked'), ['workspaces']],
      [getProjectsDir(), ['']],
      [project, ['..']],
      [project, ['.']],
      [project, ['workspaces/w1']],
      [project, ['workspaces\0']],
    ]
    for (const [dir, names] of refusals) {
      await expect(removeAsRoot(dir, names), `${dir} ${names.join()}`).rejects.toThrow(/refusing/)
    }
    expect(appliedRootPods()).toEqual([])
    expect(await fs.readdir(project)).toEqual(['workspaces'])
  })

  it('gives each call its own pod, sweeping only the finished ones a crashed server left', async () => {
    podsRunAsRoot('Succeeded')
    const labels = { app: 'yaac-root-remove', 'yaac.install-id': installId() }
    fakeCluster.seed(
      { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'done', namespace: k8sNamespace(), labels }, status: { phase: 'Failed' } },
      { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'busy', namespace: k8sNamespace(), labels }, status: { phase: 'Running' } },
    )
    await fs.mkdir(path.join(project, 'workspaces', 'w2'))
    const ws = path.join(project, 'workspaces')
    await expect(Promise.all([removeAsRoot(ws, ['w1']), removeAsRoot(ws, ['w2'])])).resolves.toEqual([true, true])

    expect(await fs.readdir(ws)).toEqual([])
    const names = fakeCluster.callsOf('apply', 'Pod').map((c) => c.name)
    expect(new Set(names).size).toBe(2)
    expect(fakeCluster.objects('Pod').map((p) => p.metadata.name)).toEqual(['busy'])
  })

  it('rejects with the pod\'s last words when it fails', async () => {
    podsRunAsRoot('Failed')
    fakeCluster.intercept((c) => {
      if (c.verb === 'apply' && c.kind === 'Pod') fakeCluster.podLogs.set(c.name ?? '', 'rm: cannot remove: Read-only file system')
    })
    await expect(removeAsRoot(project, ['workspaces'])).rejects.toThrow(/ended Failed: rm: cannot remove: Read-only/)
  })
})
