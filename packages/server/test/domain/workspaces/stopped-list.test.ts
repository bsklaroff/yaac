import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
// The listing joins DB rows with the live runtimes, which are faked. It
// never reads a transcript, which the prompt test checks by leaving one on
// disk that the rows do not record.
import {
  recordWorkspaceCreated,
  recordWorkspaceStopped,
  setWorkspaceTitle,
} from '#db/workspace-store'
import { createWorkspaceGroup } from '#db/group-store'
import { recordAgentSessions } from '#db/agent-session-store'
import { closeDb } from '#db/client'
import { claudeDir } from '@yaac/shared/project-paths'
import { listStoppedWorkspaces } from '#domain/workspaces/stopped-list'
import type { AgentTool, StoppedWorkspaceEntry } from '@yaac/shared/types'
import { DEMO_PROJECT_ID, recordTestProject } from '@yaac/test-utils/project-fixture'

const NOPE = '4101bef8-794f-4d98-8e95-dfb54850c68b'

const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'

/** Record a workspace, its first conversation, and optionally its stop. */
async function seedWorkspace(
  projectId: string,
  workspaceId: string,
  opts: { tool?: AgentTool; deleted?: boolean } = {},
): Promise<void> {
  await recordWorkspaceCreated({ projectId: projectId, workspaceId })
  // A real create always records a conversation, which is where the tool
  // and first prompt are read from.
  await recordAgentSessions(projectId, workspaceId, [
    { tool: opts.tool ?? 'claude', agentSessionId: workspaceId },
  ])
  if (opts.deleted) await recordWorkspaceStopped(projectId, workspaceId)
}

/** The listed ids, in order. */
async function ids(query: Parameters<typeof listStoppedWorkspaces>[0] = { project: DEMO_PROJECT_ID }): Promise<string[]> {
  return (await listStoppedWorkspaces(query)).entries.map((e) => e.workspaceId)
}

/** The project's stopped entries, in order. */
async function entries(): Promise<StoppedWorkspaceEntry[]> {
  return (await listStoppedWorkspaces({ project: DEMO_PROJECT_ID })).entries
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('listStoppedWorkspaces', () => {
  let tmpDir: string

  beforeEach(async () => {
    installFakeWorkspaceDriver()
    tmpDir = await createTempDataDir()
    await recordTestProject(DEMO_PROJECT_ID)
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the project filter points at an unknown projectId', async () => {
    await expect(listStoppedWorkspaces({ project: NOPE })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns an empty page when nothing has been recorded', async () => {
    expect(await listStoppedWorkspaces()).toEqual({ entries: [], total: 0 })
  })

  it('lists recorded sessions that have no active pod', async () => {
    await seedWorkspace(DEMO_PROJECT_ID, 'aaaaaa', { deleted: true })
    const result = await entries()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      workspaceId: 'aaaaaa',
      projectId: DEMO_PROJECT_ID,
      tool: 'claude',
    })
    expect(result[0]?.stoppedAt).toBeDefined()
  })

  it('skips a workspace with no recorded stop, and one running again with its stop still recorded', async () => {
    await seedWorkspace(DEMO_PROJECT_ID, 'unstopped')
    await seedWorkspace(DEMO_PROJECT_ID, 'restarting', { deleted: true })
    await seedWorkspace(DEMO_PROJECT_ID, 'stopped', { deleted: true })
    installFakeWorkspaceDriver({ list: () => Promise.resolve([handleFixture({ workspaceId: 'restarting' })]) })
    expect(await listStoppedWorkspaces({ project: DEMO_PROJECT_ID }))
      .toMatchObject({ entries: [{ workspaceId: 'stopped' }], total: 1 })
  })

  it('still lists the recorded stops when the runtime is unreachable', async () => {
    await seedWorkspace(DEMO_PROJECT_ID, 'stopped', { deleted: true })
    installFakeWorkspaceDriver({ list: () => Promise.reject(new Error('cluster down')) })
    expect(await ids()).toEqual(['stopped'])
  })

  it('filters by project', async () => {
    await recordTestProject(OTHER)
    await seedWorkspace(DEMO_PROJECT_ID, 'here', { deleted: true })
    await seedWorkspace(OTHER, 'elsewhere', { deleted: true })
    expect(await ids()).toEqual(['here'])
    expect((await ids({})).sort()).toEqual(['elsewhere', 'here'])
  })

  it('orders by recorded deletion time, newest first', async () => {
    await seedWorkspace(DEMO_PROJECT_ID, 'first', { deleted: true })
    await tick()
    await seedWorkspace(DEMO_PROJECT_ID, 'second', { deleted: true })
    expect(await ids()).toEqual(['second', 'first'])
  })

  it('carries the recorded death cause and its seen flag on the entry', async () => {
    await seedWorkspace(DEMO_PROJECT_ID, 'died')
    await seedWorkspace(DEMO_PROJECT_ID, 'removed')
    await recordWorkspaceStopped(DEMO_PROJECT_ID, 'died', { reason: 'oom', detail: 'exit code 137' })
    await recordWorkspaceStopped(DEMO_PROJECT_ID, 'removed')
    const result = await entries()
    const died = result.find((r) => r.workspaceId === 'died')
    expect(died).toMatchObject({ deathReason: 'oom', deathDetail: 'exit code 137', seen: false })
    const removed = result.find((r) => r.workspaceId === 'removed')
    expect(removed?.deathReason).toBeUndefined()
    expect(removed?.deathDetail).toBeUndefined()
  })

  it('carries the title and the sidebar group', async () => {
    await seedWorkspace(DEMO_PROJECT_ID, 'sid', { deleted: true })
    await setWorkspaceTitle(DEMO_PROJECT_ID, 'sid', 'fix the parser')
    const group = await createWorkspaceGroup(DEMO_PROJECT_ID, 'release', 'sid')
    expect((await entries())[0]).toMatchObject({
      title: 'fix the parser',
      groupId: group.groupId,
    })
  })

  it('pages newest first with the full total, without repeating a row when a stop lands between pages', async () => {
    for (let i = 0; i < 5; i++) {
      await seedWorkspace(DEMO_PROJECT_ID, `s${i}`, { deleted: true })
      await tick()
    }
    const first = await listStoppedWorkspaces({ project: DEMO_PROJECT_ID, limit: 2 })
    expect(first.entries.map((e) => e.workspaceId)).toEqual(['s4', 's3'])
    expect(first.total).toBe(5)

    await seedWorkspace(DEMO_PROJECT_ID, 'late', { deleted: true })
    const second = await listStoppedWorkspaces({ project: DEMO_PROJECT_ID, limit: 2, cursor: first.nextCursor })
    expect(second.entries.map((e) => e.workspaceId)).toEqual(['s2', 's1'])
    expect(second.total).toBe(6)
    const last = await listStoppedWorkspaces({ project: DEMO_PROJECT_ID, limit: 2, cursor: second.nextCursor })
    expect(last.entries.map((e) => e.workspaceId)).toEqual(['s0'])
    expect(last.nextCursor).toBeUndefined()
  })

  it('returns every entry without a limit', async () => {
    for (const id of ['a', 'b', 'c']) await seedWorkspace(DEMO_PROJECT_ID, id, { deleted: true })
    expect(await listStoppedWorkspaces({ project: DEMO_PROJECT_ID }))
      .toMatchObject({ entries: { length: 3 }, total: 3 })
  })

  it('refuses a malformed cursor', async () => {
    await expect(listStoppedWorkspaces({ cursor: 'nope' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('searches titles, first prompts and tools case-insensitively, with LIKE wildcards taken literally', async () => {
    await seedWorkspace(DEMO_PROJECT_ID, 'titled', { deleted: true })
    await setWorkspaceTitle(DEMO_PROJECT_ID, 'titled', 'Fix the 100% parser')
    await seedWorkspace(DEMO_PROJECT_ID, 'prompted', { deleted: true })
    await recordAgentSessions(DEMO_PROJECT_ID, 'prompted', [
      { tool: 'claude', agentSessionId: 'prompted', firstPrompt: 'port the lexer' },
    ])
    await seedWorkspace(DEMO_PROJECT_ID, 'oc', { tool: 'opencode', deleted: true })

    expect(await ids({ project: DEMO_PROJECT_ID, q: 'PARSER' })).toEqual(['titled'])
    expect(await ids({ project: DEMO_PROJECT_ID, q: '100%' })).toEqual(['titled'])
    expect(await ids({ project: DEMO_PROJECT_ID, q: '1_0' })).toEqual([])
    expect(await ids({ project: DEMO_PROJECT_ID, q: 'lexer' })).toEqual(['prompted'])
    expect(await listStoppedWorkspaces({ project: DEMO_PROJECT_ID, q: 'opencode' }))
      .toMatchObject({ entries: [{ workspaceId: 'oc' }], total: 1 })
  })

  it('narrows to one group, leaves out excluded groups or workspaces, or fetches one workspace', async () => {
    await seedWorkspace(DEMO_PROJECT_ID, 'red1', { deleted: true })
    await seedWorkspace(DEMO_PROJECT_ID, 'blue1', { deleted: true })
    await seedWorkspace(DEMO_PROJECT_ID, 'loose', { deleted: true })
    const red = await createWorkspaceGroup(DEMO_PROJECT_ID, 'red', 'red1')
    const blue = await createWorkspaceGroup(DEMO_PROJECT_ID, 'blue', 'blue1')

    expect(await ids({ project: DEMO_PROJECT_ID, group: red.groupId })).toEqual(['red1'])
    expect(await listStoppedWorkspaces({ project: DEMO_PROJECT_ID, excludeGroups: [red.groupId, blue.groupId] }))
      .toMatchObject({ entries: [{ workspaceId: 'loose' }], total: 1 })
    expect((await ids({ project: DEMO_PROJECT_ID, excludeGroups: [red.groupId] })).sort()).toEqual(['blue1', 'loose'])
    expect(await ids({ workspace: 'blue1' })).toEqual(['blue1'])
    expect(await listStoppedWorkspaces({ project: DEMO_PROJECT_ID, exclude: ['red1', 'blue1'] }))
      .toMatchObject({ entries: [{ workspaceId: 'loose' }], total: 1 })
  })

  it('reports the newest recorded activity across conversations, and creation time without one', async () => {
    await seedWorkspace(DEMO_PROJECT_ID, 'active', { deleted: true })
    await recordAgentSessions(DEMO_PROJECT_ID, 'active', [
      { tool: 'claude', agentSessionId: 'active', lastActiveMs: Date.parse('2026-01-02') },
      { tool: 'claude', agentSessionId: 'cleared', lastActiveMs: Date.parse('2026-01-03') },
    ])
    await seedWorkspace(DEMO_PROJECT_ID, 'idle', { deleted: true })

    const result = await entries()
    expect(result.find((r) => r.workspaceId === 'active')?.lastActiveAt).toBe('2026-01-03 00:00:00')
    const idle = result.find((r) => r.workspaceId === 'idle')
    expect(idle?.lastActiveAt).toBe(idle?.createdAt)
  })

  it('takes the prompt from the row alone, leaving it unset when never captured', async () => {
    const workspacesDir = path.join(claudeDir(DEMO_PROJECT_ID), 'projects', '-workspace')
    await fs.mkdir(workspacesDir, { recursive: true })
    const first = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello there' } })
    await fs.writeFile(path.join(workspacesDir, 'uncaptured.jsonl'), `${first}\n`)
    await seedWorkspace(DEMO_PROJECT_ID, 'uncaptured', { deleted: true })
    await seedWorkspace(DEMO_PROJECT_ID, 'captured', { deleted: true })
    await recordAgentSessions(DEMO_PROJECT_ID, 'captured', [
      { tool: 'claude', agentSessionId: 'captured', firstPrompt: 'port the lexer' },
    ])

    const result = await entries()
    expect(result.find((r) => r.workspaceId === 'captured')?.prompt).toBe('port the lexer')
    expect(result.find((r) => r.workspaceId === 'uncaptured')?.prompt).toBeUndefined()
  })
})
