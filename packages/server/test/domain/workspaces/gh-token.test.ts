import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { workspaceDelegate } from '#test/support/delegate'
import { closeDb, getDb } from '#db/client'
import { repos } from '#db/schema'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { BUILT_IN_USER_ID } from '#db'
import { workspaceRepoToken } from '#domain/workspaces'
import { ghTokenPlaceholder } from '@yaac/shared/tool-auth'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  installFakeWorkspaceDriver()
  await recordTestProject(PROJ)
  await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'agent-ws', repos: [{ repoId: PROJ, path: 'app' }] })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('workspaceRepoToken', () => {
  // The link's own refusals, through yaac-mama, are in
  // test/api/mama/commands.test.ts.
  it("answers a GitHub repo's placeholder to the workspace itself, and to no one else", async () => {
    await (await getDb()).update(repos).set({ remoteUrl: 'https://github.com/acme/demo.git' }).where(eq(repos.id, PROJ))
    const self = workspaceDelegate(BUILT_IN_USER_ID, 'agent-ws', { projectId: PROJ })
    for (const ref of ['demo', PROJ, 'app']) expect(await workspaceRepoToken(self, 'agent', ref)).toBe(ghTokenPlaceholder(PROJ))
    for (const other of [{ kind: 'local', userId: BUILT_IN_USER_ID } as const, workspaceDelegate(BUILT_IN_USER_ID, 'sibling', { projectId: PROJ })]) {
      await expect(workspaceRepoToken(other, 'agent-ws', 'demo')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    await expect(workspaceRepoToken(self, 'agent-ws', 'nope')).rejects.toThrow('this project has no repo "nope"')
    // A repo yaac hosts has no GitHub token, and its remote is yaac's own.
    await (await getDb()).update(repos).set({ hosted: true, remoteUrl: `http://yaac.internal/api/workspace/git/${PROJ}.git` }).where(eq(repos.id, PROJ))
    await expect(workspaceRepoToken(self, 'agent-ws', 'demo')).rejects.toThrow('demo is not an https GitHub repo, so it has no token gh could use')
  })
})
