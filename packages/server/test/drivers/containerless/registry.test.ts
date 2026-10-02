import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { setDataDir } from '@yaac/shared/paths'
import {
  _resetRegistryForTests,
  countWorkspaces,
  createRuntimeSnapshot,
  findForTeardown,
  findWorkspace,
  listWorkspaces,
  readMarkers,
  rememberWorkspace,
  restoreWorkspace,
  sshAgentPidOf,
  tmuxPidOf,
  writeMarker,
  type WorkspaceMarker,
} from '#drivers/containerless/registry'
import { containerlessJobName, markerPath } from '#drivers/containerless/paths'

const A = '4bfc59c6-1e83-4dd0-80f1-735294d5d2bb'
const B = '00000000-0000-4000-8000-000000000000'
let dataDir: string

function marker(workspaceId: string, over: Partial<WorkspaceMarker> = {}): WorkspaceMarker {
  return {
    projectSlug: 'demo', workspaceId, tool: 'claude', mode: 'tui',
    prewarm: false, createdAtMs: 1_000, launchEnv: {}, ...over,
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

describe('findWorkspace', () => {
  // Prefix expansion happens in the domain layer, over rows.
  it('resolves by exact id only, as a running workspace addressed by its minted handle', () => {
    rememberWorkspace(marker(A))
    expect(findWorkspace(A)).toMatchObject({
      workspaceId: A, jobName: containerlessJobName('demo', A), running: true, state: 'running',
    })
    expect(findWorkspace(A.slice(0, 8))).toBeUndefined()
    expect(findWorkspace(containerlessJobName('demo', A))).toBeUndefined()
    expect(findWorkspace('')).toBeUndefined()
  })

  it('passes over an unclaimed spare, which is not a workspace', () => {
    rememberWorkspace(marker(A, { prewarm: true }))
    expect(findWorkspace(A)).toBeUndefined()
  })
})

describe('findForTeardown', () => {
  it('hands back the unit name a stop has to address, a spare only when asked', () => {
    rememberWorkspace(marker(A, { prewarm: true }))
    expect(findForTeardown(A, { spares: true })).toEqual({
      projectSlug: 'demo', workspaceId: A, unitName: containerlessJobName('demo', A),
    })
    expect(findForTeardown(A)).toBeUndefined()
    expect(findForTeardown(A.slice(0, 8), { spares: true })).toBeUndefined()
  })
})

describe('listWorkspaces', () => {
  it('filters to one project when asked', () => {
    rememberWorkspace(marker(A))
    rememberWorkspace(marker(B, { projectSlug: 'other' }))
    expect(listWorkspaces('demo').map((w) => w.workspaceId)).toEqual([A])
    expect(listWorkspaces()).toHaveLength(2)
  })

  /** Recover the registry from markers on disk, as a new server does. */
  async function restart(): Promise<void> {
    _resetRegistryForTests()
    for (const m of await readMarkers()) restoreWorkspace(m, true, { reason: 'pod-stopped' })
  }

  it('lists every workspace a previous server left running, with what only the launch knew', async () => {
    await restart()
    // An install that has never had a project.
    expect(listWorkspaces()).toEqual([])

    await writeMarker(marker(A, { tmuxPid: 4242, sshAgentPid: 777, declaredTool: 'codex' }))
    await writeMarker(marker(B, { projectSlug: 'other' }))
    await restart()
    expect(listWorkspaces().map((w) => w.workspaceId).sort()).toEqual([B, A].sort())
    expect(findWorkspace(A)?.declaredTool).toBe('codex')
    // The processes teardown must kill survive the reread.
    expect(tmuxPidOf(A)).toBe(4242)
    expect(sshAgentPidOf(A)).toBe(777)
  })

  it('takes identity from the marker path, and skips one it cannot read', async () => {
    // Otherwise a copied state dir would claim to be its source workspace.
    await writeMarker(marker(A))
    await fsp.writeFile(markerPath('demo', A), JSON.stringify({
      ...marker(A), projectSlug: 'somewhere-else', workspaceId: 'not-this-one',
    }))
    // One bad file must not fail the whole recovery.
    await fsp.mkdir(path.dirname(markerPath('demo', B)), { recursive: true })
    await fsp.writeFile(markerPath('demo', B), 'not json')
    await restart()
    expect(listWorkspaces().map((w) => [w.projectSlug, w.workspaceId])).toEqual([['demo', A]])
  })
})

describe('countWorkspaces', () => {
  it('excludes spares, which are not anyone\'s workspace yet', () => {
    rememberWorkspace(marker(A))
    rememberWorkspace(marker(B, { prewarm: true }))
    expect(countWorkspaces()).toEqual({ demo: 1 })
  })
})

describe('createRuntimeSnapshot', () => {
  it('never reports a stray unit: the tmux server IS the unit', async () => {
    rememberWorkspace(marker(A))
    const snap = createRuntimeSnapshot(true)
    expect((await snap.workspaces()).map((w) => w.workspaceId)).toEqual([A])
    // A stray unit is a k8s Job outliving its pod; here there is no
    // equivalent.
    expect(await snap.strayUnits()).toEqual([])
  })

  it('holds one view for the whole pass, whatever changes under it', async () => {
    rememberWorkspace(marker(A))
    const snap = createRuntimeSnapshot()
    rememberWorkspace(marker(B))
    // Destructive steps must all judge absence against the same view.
    expect(await snap.workspaces()).toHaveLength(1)
  })
})
