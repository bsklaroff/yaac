import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { workspaceCheckpointsDir } from '@yaac/shared/project-paths'
import { collectCheckpointBundles, reconcileTreeSalvage } from '#domain/workspaces'
import { applyWorkspaceEvent, getWorkspaceRow, listTreeLives } from '#db'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver, resetWorkspaceDriver, snapshotFixture } from '#test/support/fake-driver'
import { seedProject } from '@yaac/test-utils/project-fixture'
import type { WorkspaceDriver } from '#drivers/contract'

/**
 * The server's half of a k8s workspace's files on its node
 * (docs/node-local-workspaces.md "Life cycle", "The log"), against a
 * real database and checkpoint dirs, the driver faked at its salvage verb.
 */

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const SHA = 'a'.repeat(40)
let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject(PROJ)
})

afterEach(async () => {
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

async function writeManifest(workspaceId: string, life: string, m: { final: boolean; bundles: string[]; takenAt?: string }): Promise<void> {
  const dir = path.join(workspaceCheckpointsDir(PROJ, workspaceId), 'lives', life)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    version: 1, life, takenAt: m.takenAt ?? new Date().toISOString(), final: m.final, pass: SHA,
    bundles: m.bundles, units: [{ kind: 'root' }], unsaved: [],
  }))
}

/** A stopped workspace whose one life kept its tree on `node`. */
async function stoppedTreeWorkspace(workspaceId: string, life: string, node?: string): Promise<Date> {
  const at = new Date(Date.now() - 60_000)
  await recordWorkspaceCreated({ projectId: PROJ, workspaceId, repos: [], at, treeDir: life })
  if (node !== undefined) await applyWorkspaceEvent({ type: 'life-node-found', projectId: PROJ, workspaceId, node })
  await applyWorkspaceEvent({ type: 'workspace-stopped', projectId: PROJ, workspaceId })
  return at
}

describe('reconcileTreeSalvage', () => {
  it('stamps a life by its own final pass, salvages one killed on a live node, and records one lost with its node', async () => {
    const salvaged: string[] = []
    const salvageTree = vi.fn<WorkspaceDriver['salvageTree']>(async (t) => {
      salvaged.push(t.workspaceId)
      if (t.node === 'gone') return 'node-gone'
      // The salvage pod's final pass writes the life's final manifest.
      if (t.workspaceId === 'killed') await writeManifest('killed', t.tree.life, { final: true, bundles: ['bundles/k.bundle'] })
      return 'saved'
    })
    installFakeWorkspaceDriver({ salvageTree })
    await stoppedTreeWorkspace('clean', 'L1', 'node-a')
    await writeManifest('clean', 'L1', { final: true, bundles: ['bundles/c.bundle'] })
    await stoppedTreeWorkspace('killed', 'L1', 'node-a')
    await stoppedTreeWorkspace('lost', 'L1', 'gone')
    await writeManifest('lost', 'L1', { final: false, bundles: ['bundles/l.bundle'], takenAt: '2026-11-14T00:00:00.000Z' })
    await stoppedTreeWorkspace('unscheduled', 'L1')
    // A workspace whose unit is still there is left alone.
    await stoppedTreeWorkspace('busy', 'L1', 'node-a')

    await reconcileTreeSalvage(snapshotFixture([], [{ workspaceId: 'busy', unitName: 'u', projectId: PROJ, createdAtMs: 1, prewarmed: false }]))
    await vi.waitFor(async () => {
      for (const id of ['clean', 'killed', 'lost', 'unscheduled']) expect((await listTreeLives(id))[0].checkpointedAt).toBeDefined()
    })
    const outcome = async (id: string): Promise<string | undefined> => (await listTreeLives(id))[0].checkpointOutcome
    expect(await outcome('clean')).toBe('final')
    expect(await outcome('killed')).toBe('salvaged')
    expect(await outcome('lost')).toBe('lost')
    expect(await outcome('unscheduled')).toBe('nothing')
    expect((await listTreeLives('busy'))[0].checkpointedAt).toBeUndefined()
    expect(salvaged.sort()).toEqual(['killed', 'lost'])
    const lostRow = await getWorkspaceRow(PROJ, 'lost')
    expect(lostRow?.deathReason).toBe('node-lost')
    expect(lostRow?.deathDetail).toContain('2026-11-14T00:00:00.000Z')
  })
})

describe('collectCheckpointBundles', () => {
  it('removes old bundles no kept manifest names, keeping the two newest manifests\' and a lost life\'s', async () => {
    const dir = workspaceCheckpointsDir(PROJ, 'w')
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'w', repos: [], at: new Date(1), treeDir: 'L0' })
    await applyWorkspaceEvent({ type: 'life-checkpointed', projectId: PROJ, workspaceId: 'w', life: new Date(1), outcome: 'lost' })
    await writeManifest('w', 'L0', { final: false, bundles: ['bundles/lost.bundle'], takenAt: '2026-01-01T00:00:00.000Z' })
    await writeManifest('w', 'L1', { final: true, bundles: ['bundles/a.bundle'], takenAt: '2026-01-02T00:00:00.000Z' })
    await writeManifest('w', 'L2', { final: true, bundles: ['bundles/a.bundle', 'bundles/b.bundle'], takenAt: '2026-01-03T00:00:00.000Z' })
    await writeManifest('w', 'L3', { final: false, bundles: ['bundles/a.bundle', 'bundles/c.bundle'], takenAt: '2026-01-04T00:00:00.000Z' })
    await fs.mkdir(path.join(dir, 'bundles'), { recursive: true })
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    for (const name of ['lost', 'a', 'b', 'c', 'stray', 'x.bundle.tmp-1']) {
      const file = path.join(dir, 'bundles', name.includes('.') ? name : `${name}.bundle`)
      await fs.writeFile(file, '')
      await fs.utimes(file, old, old)
    }
    // Written moments ago: maybe a pass's whose manifest is not in yet.
    await fs.writeFile(path.join(dir, 'bundles', 'fresh.bundle'), '')
    await fs.writeFile(path.join(dir, 'bundles', 'bad.bundle.unreadable'), '')

    await collectCheckpointBundles()
    expect((await fs.readdir(path.join(dir, 'bundles'))).sort())
      .toEqual(['a.bundle', 'b.bundle', 'bad.bundle.unreadable', 'c.bundle', 'fresh.bundle', 'lost.bundle'])
  })
})
