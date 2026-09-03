import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { setDataDir } from '@yaac/shared/paths'
import {
  _resetRegistryForTests,
  countForProject,
  countWorkspaces,
  createRuntimeSnapshot,
  findForTeardown,
  findWorkspace,
  listWorkspaces,
  readMarkers,
  rememberWorkspace,
  restoreWorkspace,
  sshAgentPidOf,
  writeMarker,
  type WorkspaceMarker,
} from '#drivers/containerless/registry'
import { containerlessJobName, markerPath } from '#drivers/containerless/paths'

const A = '4bfc59c6-1e83-4dd0-80f1-735294d5d2bb'
const B = '00000000-0000-4000-8000-000000000000'
let dataDir: string

function marker(worktreeId: string, over: Partial<WorkspaceMarker> = {}): WorkspaceMarker {
  return {
    projectSlug: 'demo', worktreeId, tool: 'claude', mode: 'tui',
    prewarm: false, createdAtMs: 1_000, ...over,
  }
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-cl-registry-'))
  setDataDir(dataDir)
  _resetRegistryForTests()
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('rememberWorkspace', () => {
  it('answers as a running workspace addressed by the handle it minted', () => {
    const handle = rememberWorkspace(marker(A))
    expect(handle.jobName).toBe(containerlessJobName('demo', A))
    expect(handle.running).toBe(true)
    expect(handle.state).toBe('running')
  })
})

describe('findWorkspace', () => {
  it('resolves by id, by prefix, and by handle', () => {
    rememberWorkspace(marker(A))
    expect(findWorkspace(A)?.workspaceId).toBe(A)
    expect(findWorkspace(A.slice(0, 8))?.workspaceId).toBe(A)
    expect(findWorkspace(containerlessJobName('demo', A))?.workspaceId).toBe(A)
  })

  it('answers nothing for a prefix two workspaces share', () => {
    // Resolving to an arbitrary one would send an exec — or a teardown — at
    // the wrong worktree.
    rememberWorkspace(marker('0000aaaa-0000-4000-8000-000000000001'))
    rememberWorkspace(marker('0000aaaa-0000-4000-8000-000000000002'))
    expect(findWorkspace('0000aaaa')).toBeUndefined()
  })
})

describe('findForTeardown', () => {
  it('hands back the unit name a stop has to address', () => {
    rememberWorkspace(marker(A))
    expect(findForTeardown(A)).toEqual({
      projectSlug: 'demo', workspaceId: A, unitName: containerlessJobName('demo', A),
    })
  })
})

describe('listWorkspaces', () => {
  it('filters to one project when asked', () => {
    rememberWorkspace(marker(A))
    rememberWorkspace(marker(B, { projectSlug: 'other' }))
    expect(listWorkspaces('demo').map((w) => w.workspaceId)).toEqual([A])
    expect(listWorkspaces()).toHaveLength(2)
  })
})

describe('countWorkspaces', () => {
  it('excludes spares, which are not anyone\'s worktree yet', () => {
    rememberWorkspace(marker(A))
    rememberWorkspace(marker(B, { prewarm: true }))
    expect(countWorkspaces()).toEqual({ demo: 1 })
  })
})

describe('countForProject', () => {
  it('includes spares, unlike the per-project display counts', () => {
    rememberWorkspace(marker(A))
    rememberWorkspace(marker(B, { prewarm: true }))
    expect(countForProject('demo')).toBe(2)
  })
})

describe('createRuntimeSnapshot', () => {
  it('never reports a stray unit: the tmux server IS the unit', async () => {
    rememberWorkspace(marker(A))
    const snap = createRuntimeSnapshot(true)
    expect((await snap.workspaces()).map((w) => w.workspaceId)).toEqual([A])
    // A stray unit is a Job outliving its pod; when this substrate's unit is
    // gone there is nothing left holding anything.
    expect(await snap.strayUnits()).toEqual([])
  })

  it('holds one view for the whole pass, whatever changes under it', async () => {
    rememberWorkspace(marker(A))
    const snap = createRuntimeSnapshot()
    rememberWorkspace(marker(B))
    // A destructive step must never judge absence against a view another
    // step already invalidated.
    expect(await snap.workspaces()).toHaveLength(1)
  })
})

describe('readMarkers', () => {
  it('finds every workspace a previous server left running', async () => {
    await writeMarker(marker(A))
    await writeMarker(marker(B, { projectSlug: 'other' }))
    const found = await readMarkers()
    expect(found.map((m) => m.worktreeId).sort()).toEqual([B, A].sort())
  })

  it('takes identity from the path, not from what the file claims', async () => {
    // A state dir copied along with a project would otherwise announce
    // itself as the worktree it was copied from.
    await writeMarker(marker(A))
    const file = markerPath('demo', A)
    await fsp.writeFile(file, JSON.stringify({
      ...marker(A), projectSlug: 'somewhere-else', worktreeId: 'not-this-one',
    }))
    const [found] = await readMarkers()
    expect(found).toMatchObject({ projectSlug: 'demo', worktreeId: A })
  })

  it('skips an unreadable marker instead of failing the whole recovery', async () => {
    await writeMarker(marker(A))
    await fsp.mkdir(path.dirname(markerPath('demo', B)), { recursive: true })
    await fsp.writeFile(markerPath('demo', B), 'not json')
    // One corrupt file must not cost every other worktree its recovery.
    expect((await readMarkers()).map((m) => m.worktreeId)).toEqual([A])
  })

  it('answers empty on an install that has never had a project', async () => {
    expect(await readMarkers()).toEqual([])
  })
})

describe('writeMarker', () => {
  it('records what only the launch knew', async () => {
    await writeMarker(marker(A, { tmuxPid: 4242, declaredTool: 'codex' }))
    const raw = JSON.parse(await fsp.readFile(markerPath('demo', A), 'utf8')) as WorkspaceMarker
    expect(raw).toMatchObject({ worktreeId: A, tmuxPid: 4242, declaredTool: 'codex' })
  })
})

describe('sshAgentPidOf', () => {
  it('answers for a live workspace and for one recovered after a restart', async () => {
    // Teardown reads this to end the process holding the worktree's ssh key,
    // so it has to answer for a workspace this server did not launch — a
    // restart repopulates the same entries from the markers on disk.
    rememberWorkspace(marker(A, { sshAgentPid: 777 }))
    expect(sshAgentPidOf(A)).toBe(777)

    _resetRegistryForTests()
    await writeMarker(marker(A, { sshAgentPid: 777 }))
    for (const m of await readMarkers()) restoreWorkspace(m, true, { reason: 'pod-stopped' })
    expect(sshAgentPidOf(A)).toBe(777)
  })

  it('is undefined for a project with no SSH remote, and for an unknown id', () => {
    rememberWorkspace(marker(A))
    expect(sshAgentPidOf(A)).toBeUndefined()
    expect(sshAgentPidOf('nobody')).toBeUndefined()
  })
})
