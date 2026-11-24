import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { closeDb } from '#db/client'
import { recordProjectCreate } from '#db/project-store'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { BUILT_IN_USER_ID, closeSessionRow, insertSession } from '#db'
import { callingWorkspace } from '#domain/workspaces'
import type { PermissionMode } from '@yaac/shared/types'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'

let tmpDir: string

// One data dir for the file; each case uses workspaces of its own.
beforeAll(async () => {
  tmpDir = await createTempDataDir()
  await recordTestProject(PROJ)
  await recordTestProject(OTHER)
})

// The unit setup clears the driver after every case.
beforeEach(() => { installFakeWorkspaceDriver() })

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const session = (workspaceId: string, tool: 'claude' | 'codex', permissionMode: string, mode: 'tui' | 'acp' = 'tui') =>
  insertSession(PROJ, workspaceId, { cwd: '', tool, mode, permissionMode: permissionMode as PermissionMode })

describe('callingWorkspace', () => {
  // A session's agent says which session it runs in; anything else in the
  // workspace (a user's shell, an agent claiming a session it is not) is
  // held to the strictest of the workspace's open sessions.
  it("acts for the project's owner in its project, at its own session's posture or else the strictest open one", async () => {
    const at = { workspaceId: 'caller-one', projectId: PROJ }
    await recordWorkspaceCreated(at)
    const loose = await session('caller-one', 'codex', 'bypass', 'acp')
    const plan = await session('caller-one', 'claude', 'plan')
    const edits = await session('caller-one', 'claude', 'accept-edits', 'acp')
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'elsewhere' })
    const elsewhere = await session('elsewhere', 'claude', 'bypass')

    expect(await callingWorkspace(at, loose.id)).toEqual({
      kind: 'delegate',
      userId: BUILT_IN_USER_ID,
      login: null,
      via: { kind: 'workspace', id: 'caller-one', label: 'workspace caller-o', sessionId: loose.id },
      projectId: PROJ,
      ceiling: 'bypass',
    })
    for (const claimed of [undefined, 'not-a-session', elsewhere.id]) {
      const delegate = await callingWorkspace(at, claimed)
      expect(delegate.ceiling, String(claimed)).toBe('plan')
      expect(delegate.via).not.toHaveProperty('sessionId')
    }
    // A closed session no longer counts as the caller's.
    await closeSessionRow(loose.id)
    expect((await callingWorkspace(at, loose.id)).via).not.toHaveProperty('sessionId')

    // With none open, the strictest closed in this life still holds, so an
    // agent's detached child keeps its ceiling after the agent is gone.
    await closeSessionRow(edits.id)
    await closeSessionRow(plan.id)
    expect((await callingWorkspace(at, undefined)).ceiling).toBe('plan')

    // A posture this build does not rank counts as the strictest, wherever
    // it falls among the others.
    await session('caller-one', 'claude', 'bypass')
    const unranked = await session('caller-one', 'claude', 'dontAsk')
    await session('caller-one', 'claude', 'plan')
    expect((await callingWorkspace(at, undefined)).ceiling).toBe('dontAsk')
    expect((await callingWorkspace(at, unranked.id)).via.sessionId).toBe(unranked.id)
  })

  it('falls back to the posture a create would resolve for a workspace with no session', async () => {
    const at = { workspaceId: 'caller-two', projectId: OTHER }
    await recordWorkspaceCreated(at)
    await recordProjectCreate(OTHER, 'codex', { permissionMode: 'read-only', mode: 'acp' })
    expect(await callingWorkspace(at, undefined)).toMatchObject({ projectId: OTHER, ceiling: 'read-only' })
  })

  it("refuses a public site's release, which may not act on yaac at all", async () => {
    await expect(callingWorkspace({ workspaceId: 'release', projectId: PROJ, siteId: 's1' }, undefined))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
