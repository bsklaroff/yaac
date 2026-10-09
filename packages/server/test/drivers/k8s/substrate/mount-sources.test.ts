import { describe, it, expect, vi, afterEach } from 'vitest'
import path from 'node:path'
import type * as apiModule from '#drivers/k8s/substrate/api'

vi.mock('#drivers/k8s/substrate/api', async (importOriginal) => ({
  ...(await importOriginal<typeof apiModule>()),
  dataDirHash: () => 'ddh0123456789abc',
}))

import { nodeLocalDirsOf, nodeLocalHostPath, resolveMountSource } from '#drivers/k8s/substrate'
import type { PodMount } from '#drivers/k8s/substrate'
import { getDataDir, setDataDir } from '@yaac/shared/paths'
import {
  cachedPackagesDir,
  claudeDir,
  imageStoreDir,
  repoDir,
  workspaceDir,
} from '@yaac/shared/project-paths'
import { secretKeyPath } from '@yaac/shared/project-paths'

const NODE_ROOT = '/var/lib/yaac/node/ddh0123456789abc'

afterEach(() => {
  setDataDir('')
})

describe('resolveMountSource', () => {
  setDataDir('/data/yaac')

  it('turns a global directory into a subPath of the global claim', () => {
    setDataDir('/data/yaac')
    const m: PodMount = { source: { kind: 'hostPath', path: claudeDir('demo') }, mountPath: '/home/yaac/.claude' }
    expect(resolveMountSource(m)).toEqual({
      source: { kind: 'pvc', claimName: 'yaac-global', subPath: 'projects/demo/claude' },
      mountPath: '/home/yaac/.claude',
    })
  })

  it('mounts a checkout through the checkouts claim, at the same subPath', () => {
    setDataDir('/data/yaac')
    const m: PodMount = { source: { kind: 'hostPath', path: workspaceDir('demo', 'ws1') }, mountPath: '/workspace' }
    expect(resolveMountSource(m)).toEqual({
      source: { kind: 'pvc', claimName: 'yaac-checkouts', subPath: 'projects/demo/workspaces/ws1' },
      mountPath: '/workspace',
    })
    // Only the checkout itself: the main clone stays on the global claim.
    const repo: PodMount = { source: { kind: 'hostPath', path: `${repoDir('demo')}/.git` }, mountPath: '/r', readOnly: true }
    expect(resolveMountSource(repo).source).toEqual({ kind: 'pvc', claimName: 'yaac-global', subPath: 'projects/demo/repo/.git' })
  })

  it('turns a global File into a subPath to that file, keeping readOnly', () => {
    setDataDir('/data/yaac')
    const m: PodMount = {
      source: { kind: 'hostPath', path: path.join(claudeDir('demo'), 'settings.json'), type: 'File' },
      mountPath: '/home/yaac/.claude/settings.json',
      readOnly: true,
    }
    expect(resolveMountSource(m)).toEqual({
      source: { kind: 'pvc', claimName: 'yaac-global', subPath: 'projects/demo/claude/settings.json' },
      mountPath: '/home/yaac/.claude/settings.json',
      readOnly: true,
    })
  })

  it('turns a node-local directory into the node path, created on demand', () => {
    setDataDir('/data/yaac')
    const m: PodMount = { source: { kind: 'hostPath', path: cachedPackagesDir('demo') }, mountPath: '/home/yaac/.cached-packages' }
    expect(resolveMountSource(m)).toEqual({
      source: { kind: 'hostPath', path: `${NODE_ROOT}/projects/demo/.cached-packages`, type: 'DirectoryOrCreate' },
      mountPath: '/home/yaac/.cached-packages',
    })
    // A declared type survives.
    const gen: PodMount = {
      source: { kind: 'hostPath', path: path.join(imageStoreDir('demo'), 'gen-1'), type: 'DirectoryOrCreate' },
      mountPath: '/var/lib/shared-images',
      readOnly: true,
    }
    expect(resolveMountSource(gen).source).toEqual({
      kind: 'hostPath', path: `${NODE_ROOT}/shared-images/demo/gen-1`, type: 'DirectoryOrCreate',
    })
  })

  it('passes emptyDir and pvc sources through untouched', () => {
    const ed: PodMount = { source: { kind: 'emptyDir' }, mountPath: '/tmp/yaac-tmux' }
    expect(resolveMountSource(ed)).toBe(ed)
    const pvc: PodMount = { source: { kind: 'pvc', claimName: 'x', subPath: 'y' }, mountPath: '/x' }
    expect(resolveMountSource(pvc)).toBe(pvc)
  })

  it('refuses a server-local path: no workspace pod may mount the server\'s claim', () => {
    setDataDir('/data/yaac')
    const m: PodMount = { source: { kind: 'hostPath', path: secretKeyPath() }, mountPath: '/x' }
    expect(() => resolveMountSource(m)).toThrow(/SERVER-LOCAL/)
  })

  it('refuses a path under no tier, the data dir root included', () => {
    setDataDir('/data/yaac')
    for (const p of [getDataDir(), path.join(getDataDir(), 'stray'), '/etc/passwd']) {
      const m: PodMount = { source: { kind: 'hostPath', path: p }, mountPath: '/x' }
      expect(() => resolveMountSource(m)).toThrow(/under no storage tier root/)
    }
  })

  it('reads the pod\'s own re-rooted tiers when the roots are overridden', () => {
    setDataDir('/data/yaac')
    vi.stubEnv('YAAC_GLOBAL_ROOT', '/yaac/global')
    vi.stubEnv('YAAC_NODE_LOCAL_ROOT', '/yaac/node-local')
    try {
      expect(resolveMountSource({
        source: { kind: 'hostPath', path: '/yaac/global/projects/demo/repo/.git' }, mountPath: '/repo/.git',
      }).source).toEqual({ kind: 'pvc', claimName: 'yaac-global', subPath: 'projects/demo/repo/.git' })
      expect(resolveMountSource({
        source: { kind: 'hostPath', path: '/yaac/node-local/projects/demo/.cached-packages' }, mountPath: '/c',
      }).source).toMatchObject({ kind: 'hostPath', path: `${NODE_ROOT}/projects/demo/.cached-packages` })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('nodeLocalHostPath', () => {
  it('maps a node-local server path onto the install\'s node tree, and refuses others', () => {
    setDataDir('/data/yaac')
    expect(nodeLocalHostPath(imageStoreDir('demo'))).toBe(`${NODE_ROOT}/shared-images/demo`)
    expect(() => nodeLocalHostPath(claudeDir('demo'))).toThrow(/not under the node-local root/)
  })
})

describe('nodeLocalDirsOf', () => {
  it('lists the node-local directory mounts the pod writes, once each; files and read-only mounts excluded', () => {
    setDataDir('/data/yaac')
    const resolved = [
      { source: { kind: 'hostPath', path: cachedPackagesDir('demo') }, mountPath: '/home/yaac/.cached-packages' },
      { source: { kind: 'hostPath', path: path.join(cachedPackagesDir('demo'), 'modules', 'w1', 'node_modules') }, mountPath: '/workspace/node_modules' },
      { source: { kind: 'hostPath', path: cachedPackagesDir('demo') }, mountPath: '/twice' },
      { source: { kind: 'hostPath', path: path.join(claudeDir('demo'), 'settings.json'), type: 'File' }, mountPath: '/f' },
      // An image store generation, mounted read-only.
      { source: { kind: 'hostPath', path: path.join(imageStoreDir('demo'), 'gen-1'), type: 'DirectoryOrCreate' }, mountPath: '/var/lib/shared-images', readOnly: true },
      { source: { kind: 'emptyDir' }, mountPath: '/tmp/yaac-tmux' },
    ].map((m) => resolveMountSource(m as PodMount))
    expect(nodeLocalDirsOf(resolved)).toEqual([
      `${NODE_ROOT}/projects/demo/.cached-packages`,
      `${NODE_ROOT}/projects/demo/.cached-packages/modules/w1/node_modules`,
    ])
  })
})
