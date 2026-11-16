import { describe, it, expect, vi, afterEach } from 'vitest'
import path from 'node:path'
import type * as apiModule from '#drivers/k8s/substrate/api'

vi.mock('#drivers/k8s/substrate/api', async (importOriginal) => ({
  ...(await importOriginal<typeof apiModule>()),
}))

import { nodeLocalDirsOf, resolveMountSource } from '#drivers/k8s/substrate'
import type { PodMount } from '#drivers/k8s/substrate'
import { getDataDir, setDataDir } from '@yaac/shared/paths'
import {
  cachedPackagesDir,
  claudeDir,
  repoDir,
  workspaceDir,
} from '@yaac/shared/project-paths'
import { secretKeyPath } from '@yaac/shared/project-paths'

const NODE_ROOT = '/var/lib/yaac/node/test-install'

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

  it('mounts a checkout\'s folder and its .git through the global claim, at the same subPath', () => {
    setDataDir('/data/yaac')
    const m: PodMount = { source: { kind: 'hostPath', path: workspaceDir('demo', 'ws1') }, mountPath: '/workspace' }
    expect(resolveMountSource(m)).toEqual({
      source: { kind: 'pvc', claimName: 'yaac-global', subPath: 'projects/demo/workspaces/ws1' },
      mountPath: '/workspace',
    })
    const gitDir: PodMount = { source: { kind: 'hostPath', path: `${workspaceDir('demo', 'ws1')}/.git` }, mountPath: '/workspace/.git' }
    expect(resolveMountSource(gitDir).source).toEqual({ kind: 'pvc', claimName: 'yaac-global', subPath: 'projects/demo/workspaces/ws1/.git' })
    const repo: PodMount = { source: { kind: 'hostPath', path: `${repoDir('demo')}/.git` }, mountPath: '/r', readOnly: true }
    expect(resolveMountSource(repo).source).toEqual({ kind: 'pvc', claimName: 'yaac-global', subPath: 'repos/demo/.git' })
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
    const typed: PodMount = {
      source: { kind: 'hostPath', path: path.join(cachedPackagesDir('demo'), 'store'), type: 'Directory' },
      mountPath: '/store',
      readOnly: true,
    }
    expect(resolveMountSource(typed).source).toEqual({
      kind: 'hostPath', path: `${NODE_ROOT}/projects/demo/.cached-packages/store`, type: 'Directory',
    })
  })

  it('passes emptyDir and pvc sources through untouched', () => {
    const ed: PodMount = { source: { kind: 'emptyDir' }, mountPath: '/tmp/yaac-tmux' }
    expect(resolveMountSource(ed)).toBe(ed)
    const pvc: PodMount = { source: { kind: 'pvc', claimName: 'x', subPath: 'y' }, mountPath: '/x' }
    expect(resolveMountSource(pvc)).toBe(pvc)
  })

  it('mounts a volume from the yaac-volumes claim on kind, and from its own claim on byo', () => {
    const m = { source: { kind: 'volume' as const, volumeId: 'v1' }, mountPath: '/home/yaac/volume' }
    expect(resolveMountSource(m).source).toEqual({ kind: 'pvc', claimName: 'yaac-volumes', subPath: 'v1' })
    vi.stubEnv('YAAC_VOLUME_STORAGE_CLASS', 'hcloud-volumes')
    expect(resolveMountSource(m)).toEqual({ ...m, source: { kind: 'pvc', claimName: 'yaac-volume-v1' } })
    vi.unstubAllEnvs()
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
        source: { kind: 'hostPath', path: '/yaac/global/repos/demo/.git' }, mountPath: '/repo/.git',
      }).source).toEqual({ kind: 'pvc', claimName: 'yaac-global', subPath: 'repos/demo/.git' })
      expect(resolveMountSource({
        source: { kind: 'hostPath', path: '/yaac/node-local/projects/demo/.cached-packages' }, mountPath: '/c',
      }).source).toMatchObject({ kind: 'hostPath', path: `${NODE_ROOT}/projects/demo/.cached-packages` })
    } finally {
      vi.unstubAllEnvs()
    }
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
      // Read-only.
      { source: { kind: 'hostPath', path: path.join(cachedPackagesDir('demo'), 'store'), type: 'DirectoryOrCreate' }, mountPath: '/store', readOnly: true },
      { source: { kind: 'emptyDir' }, mountPath: '/tmp/yaac-tmux' },
    ].map((m) => resolveMountSource(m as PodMount))
    expect(nodeLocalDirsOf(resolved)).toEqual([
      `${NODE_ROOT}/projects/demo/.cached-packages`,
      `${NODE_ROOT}/projects/demo/.cached-packages/modules/w1/node_modules`,
    ])
  })
})
