import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
// The listing joins DB rows with what is read off disk (live runtimes,
// transcripts for prompts and last-activity stamps). Only the runtime is
// faked; the rest runs for real.
import {
  recordWorkspaceCreated,
  recordWorkspaceStopped,
  setWorkspaceTitle,
} from '#db/workspace-store'
import { createWorkspaceGroup } from '#db/group-store'
import { listWorkspaceAgentSessions, recordAgentSessions } from '#db/agent-session-store'
import { closeDb } from '#db/client'
import { claudeDir } from '@yaac/shared/project-paths'
import { listStoppedWorkspaces } from '#domain/workspaces/stopped-list'
import type { AgentTool } from '@yaac/shared/types'
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
    await expect(listStoppedWorkspaces(NOPE)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns [] when nothing has been recorded', async () => {
    expect(await listStoppedWorkspaces()).toEqual([])
  })

  it('lists recorded sessions that have no active pod', async () => {
    await seedWorkspace(DEMO_PROJECT_ID, 'aaaaaa', { deleted: true })
    const result = await listStoppedWorkspaces(DEMO_PROJECT_ID)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      workspaceId: 'aaaaaa',
      projectId: DEMO_PROJECT_ID,
      tool: 'claude',
    })
    expect(result[0]?.stoppedAt).toBeDefined()
  })

  it('skips sessions that are still running', async () => {
    await seedWorkspace(DEMO_PROJECT_ID, 'active1')
    installFakeWorkspaceDriver({ list: () => Promise.resolve([handleFixture({ workspaceId: 'active1' })]) })
    expect(await listStoppedWorkspaces(DEMO_PROJECT_ID)).toEqual([])
  })

  it('treats every recorded session as stopped when the runtime is unreachable', async () => {
    await seedWorkspace(DEMO_PROJECT_ID, 'active1')
    installFakeWorkspaceDriver({ list: () => Promise.reject(new Error('cluster down')) })
    expect((await listStoppedWorkspaces(DEMO_PROJECT_ID)).map((r) => r.workspaceId)).toEqual(['active1'])
  })

  it('filters by project', async () => {
    await recordTestProject(OTHER)
    await seedWorkspace(DEMO_PROJECT_ID, 'here', { deleted: true })
    await seedWorkspace(OTHER, 'elsewhere', { deleted: true })
    expect((await listStoppedWorkspaces(DEMO_PROJECT_ID)).map((r) => r.workspaceId)).toEqual(['here'])
    expect((await listStoppedWorkspaces()).map((r) => r.workspaceId).sort()).toEqual(['elsewhere', 'here'])
  })

  it('orders by recorded deletion time, newest first', async () => {
    await seedWorkspace(DEMO_PROJECT_ID, 'first', { deleted: true })
    await new Promise((r) => setTimeout(r, 5))
    await seedWorkspace(DEMO_PROJECT_ID, 'second', { deleted: true })
    expect((await listStoppedWorkspaces(DEMO_PROJECT_ID)).map((r) => r.workspaceId)).toEqual(['second', 'first'])
  })

  it('orders a session removed out of band by its last activity', async () => {
    // `busy` and `idle` have no recorded stop, so each sorts by last
    // activity: `idle` (no transcript) by its creation, just before `recent`
    // stopped, and `busy` (created first) by a transcript written after both.
    const dir = path.join(claudeDir(DEMO_PROJECT_ID), 'projects', '-workspace')
    await fs.mkdir(dir, { recursive: true })
    const transcript = path.join(dir, 'busy.jsonl')
    await fs.writeFile(transcript, '{}\n')
    await seedWorkspace(DEMO_PROJECT_ID, 'busy')
    await recordAgentSessions(DEMO_PROJECT_ID, 'busy', [{
      tool: 'claude',
      agentSessionId: 'busy',
      transcriptPath: path.join('claude', 'projects', '-workspace', 'busy.jsonl'),
    }])
    await new Promise((r) => setTimeout(r, 5))
    await seedWorkspace(DEMO_PROJECT_ID, 'idle', { tool: 'opencode' })
    await new Promise((r) => setTimeout(r, 5))
    await seedWorkspace(DEMO_PROJECT_ID, 'recent', { deleted: true })
    const later = new Date(Date.now() + 60_000)
    await fs.utimes(transcript, later, later)

    const result = await listStoppedWorkspaces(DEMO_PROJECT_ID)
    expect(result.map((r) => r.workspaceId)).toEqual(['busy', 'recent', 'idle'])
    expect(result.find((r) => r.workspaceId === 'idle')?.stoppedAt).toBeUndefined()
  })

  it('carries the recorded death cause and its seen flag on the entry', async () => {
    await seedWorkspace(DEMO_PROJECT_ID, 'died')
    await seedWorkspace(DEMO_PROJECT_ID, 'removed')
    await recordWorkspaceStopped(DEMO_PROJECT_ID, 'died', { reason: 'oom', detail: 'exit code 137' })
    await recordWorkspaceStopped(DEMO_PROJECT_ID, 'removed')
    const result = await listStoppedWorkspaces(DEMO_PROJECT_ID)
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
    expect((await listStoppedWorkspaces(DEMO_PROJECT_ID))[0]).toMatchObject({
      title: 'fix the parser',
      groupId: group.groupId,
    })
  })

  it('caps results to the requested limit after sorting newest-first', async () => {
    for (let i = 0; i < 5; i++) {
      await seedWorkspace(DEMO_PROJECT_ID, `s${i}`, { deleted: true })
      await new Promise((r) => setTimeout(r, 5))
    }
    const result = await listStoppedWorkspaces(DEMO_PROJECT_ID, 2)
    expect(result.map((r) => r.workspaceId)).toEqual(['s4', 's3'])
  })

  it('keeps a grouped session past the cap so its ghost row survives', async () => {
    await seedWorkspace(DEMO_PROJECT_ID, 'grouped', { deleted: true })
    await createWorkspaceGroup(DEMO_PROJECT_ID, 'release', 'grouped')
    await new Promise((r) => setTimeout(r, 5))
    for (const id of ['a', 'b', 'c']) {
      await seedWorkspace(DEMO_PROJECT_ID, id, { deleted: true })
      await new Promise((r) => setTimeout(r, 5))
    }
    const result = await listStoppedWorkspaces(DEMO_PROJECT_ID, 2)
    expect(result.map((r) => r.workspaceId).sort()).toEqual(['b', 'c', 'grouped'])
  })

  it('returns all entries when limit is 0 or undefined', async () => {
    for (const id of ['a', 'b', 'c']) await seedWorkspace(DEMO_PROJECT_ID, id, { deleted: true })
    expect(await listStoppedWorkspaces(DEMO_PROJECT_ID)).toHaveLength(3)
    expect(await listStoppedWorkspaces(DEMO_PROJECT_ID, 0)).toHaveLength(3)
  })

  it('reports last activity from the transcript, and creation time without one', async () => {
    const workspacesDir = path.join(claudeDir(DEMO_PROJECT_ID), 'projects', '-workspace')
    await fs.mkdir(workspacesDir, { recursive: true })
    const transcript = path.join(workspacesDir, 'withlog.jsonl')
    await fs.writeFile(transcript, '{}\n')
    await fs.utimes(transcript, new Date('2026-01-02'), new Date('2026-01-02'))
    await seedWorkspace(DEMO_PROJECT_ID, 'withlog', { deleted: true })
    // Last activity comes from the workspace's conversations. The path is
    // relative, as discovery records it; an absolute one would be refused and
    // the listing would fall back to the conventional path, so the test
    // would not check the recorded path at all.
    await recordAgentSessions(DEMO_PROJECT_ID, 'withlog', [
      {
        tool: 'claude',
        agentSessionId: 'withlog',
        transcriptPath: path.join('claude', 'projects', '-workspace', 'withlog.jsonl'),
        firstPrompt: 'hi',
      },
    ])
    await seedWorkspace(DEMO_PROJECT_ID, 'nolog', { tool: 'opencode', deleted: true })

    const result = await listStoppedWorkspaces(DEMO_PROJECT_ID)
    expect(result.find((r) => r.workspaceId === 'withlog')?.lastActiveAt).toBe('2026-01-02 00:00:00')
    const nolog = result.find((r) => r.workspaceId === 'nolog')
    expect(nolog?.lastActiveAt).toBe(nolog?.createdAt)
  })

  it('parses the prompt on demand for a session that died before capture, then keeps it', async () => {
    const workspacesDir = path.join(claudeDir(DEMO_PROJECT_ID), 'projects', '-workspace')
    await fs.mkdir(workspacesDir, { recursive: true })
    const first = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello there' } })
    await fs.writeFile(path.join(workspacesDir, 'a.jsonl'), `${first}\n`)
    await seedWorkspace(DEMO_PROJECT_ID, 'a', { deleted: true })

    expect((await listStoppedWorkspaces(DEMO_PROJECT_ID))[0]?.prompt).toBe('hello there')
    // The parse read an absolute path but must record the relative form.
    const [link] = await listWorkspaceAgentSessions(DEMO_PROJECT_ID, 'a')
    expect(link?.transcriptPath).toBe(path.join('claude', 'projects', '-workspace', 'a.jsonl'))
    // The prompt is persisted, so it survives the transcript's removal.
    await fs.rm(path.join(workspacesDir, 'a.jsonl'))
    expect((await listStoppedWorkspaces(DEMO_PROJECT_ID))[0]?.prompt).toBe('hello there')
  })

  it('leaves the prompt unset for an opencode session that was never captured', async () => {
    await seedWorkspace(DEMO_PROJECT_ID, 'ocsess', { tool: 'opencode', deleted: true })
    expect((await listStoppedWorkspaces(DEMO_PROJECT_ID))[0]).toMatchObject({
      workspaceId: 'ocsess',
      tool: 'opencode',
    })
    expect((await listStoppedWorkspaces(DEMO_PROJECT_ID))[0]?.prompt).toBeUndefined()
  })
})
