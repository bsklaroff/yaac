import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { workspaceDelegate } from '#test/support/delegate'
import { closeDb } from '#db/client'
import { recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { recordConversations } from '#db/conversation-store'
import { BUILT_IN_USER_ID, insertSession } from '#db'
import { sendMessage } from '#domain/workspaces'
import type { WorkspaceDriver } from '#drivers/contract'
import { _resetAcpRegistryForTests, refuseAcpHandle } from '#runtime/agents/acp-registry'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const exec = vi.fn<WorkspaceDriver['exec']>()

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  exec.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  installFakeWorkspaceDriver({
    find: (id) => Promise.resolve(id === 'target' ? handleFixture({ projectId: PROJ, workspaceId: id, jobName: 'yaac-target' }) : undefined),
    exec,
  })
  await recordTestProject(PROJ)
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** The message the last delivery carried, as its script holds it. */
const carried = (message: string): boolean =>
  (exec.mock.calls.at(-1)?.[2]?.stdin ?? '').includes(Buffer.from(message, 'utf8').toString('base64'))

describe('sendMessage', () => {
  // The rest of what a send refuses, through yaac-mama, is in
  // test/api/mama/commands.test.ts.
  it("delivers headed with who sent it, a delegate's within its ceiling and never to its own session", async () => {
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'target' })
    await recordConversations(PROJ, 'target', [{ tool: 'claude', conversationId: 'c1' }, { tool: 'claude', conversationId: 'c2' }])
    const first = await insertSession(PROJ, 'target', { cwd: '', tool: 'claude', mode: 'tui', permissionMode: 'bypass', conversationId: 'c1' })
    const second = await insertSession(PROJ, 'target', { cwd: '', tool: 'claude', mode: 'tui', permissionMode: 'plan', conversationId: 'c2' })

    expect(await sendMessage(local, 'targ', { message: 'from you' })).toEqual({ workspaceId: 'target', sessionId: first.id, tool: 'claude' })
    expect(carried('Sent by local via yaac workspace send:\n\nfrom you')).toBe(true)

    const agent = workspaceDelegate(BUILT_IN_USER_ID, 'caller', { projectId: PROJ, ceiling: 'plan' })
    await expect(sendMessage(agent, 'target', { message: 'x' })).rejects.toMatchObject({
      code: 'FORBIDDEN', message: expect.stringContaining("permission mode 'bypass' is more permissive than workspace caller's ceiling") as string,
    })
    expect((await sendMessage(agent, 'target', { message: 'peer', conversation: 'c2' })).sessionId).toBe(second.id)
    expect(carried('Sent from caller via yaac-mama:\n\npeer')).toBe(true)
    // A session of the workspace is never sent its own message.
    const own = workspaceDelegate(BUILT_IN_USER_ID, 'target', { projectId: PROJ, sessionId: second.id })
    await expect(sendMessage(own, 'target', { message: 'x', session: second.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(sendMessage(local, 'target', { message: ' \x07 ' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('refuses an agent with no conversation, saying why when it will never start one', async () => {
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'target' })
    const session = await insertSession(PROJ, 'target', { cwd: '', tool: 'codex', mode: 'acp', permissionMode: 'bypass' })
    await expect(sendMessage(local, 'target', { message: 'x' })).rejects.toThrow(/has no conversation yet; try again once its agent is up$/)
    refuseAcpHandle(PROJ, 'target', session.window, 'codex is not signed in')
    try {
      await expect(sendMessage(local, 'target', { message: 'x' })).rejects.toThrow(/codex agent [0-9a-f]{8}: codex is not signed in$/)
    } finally {
      _resetAcpRegistryForTests()
    }
    expect(exec).not.toHaveBeenCalled()
  })

  it('refuses a workspace that is not running, saying whether it is stopped', async () => {
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'gone' })
    await recordWorkspaceStopped(PROJ, 'gone')
    await expect(sendMessage(local, 'gone', { message: 'x' })).rejects.toThrow('workspace gone is stopped; restart it, then send once it is running')
    expect(exec).not.toHaveBeenCalled()
  })
})
