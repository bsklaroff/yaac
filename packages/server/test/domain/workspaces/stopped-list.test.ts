import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installRealWorkspaceDriver } from '@yaac/test-utils/real-driver'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

vi.mock('#drivers/k8s/substrate/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listWorkspacePods: vi.fn().mockResolvedValue([]),
  }
})

import { listWorkspacePods } from '#drivers/k8s/substrate/pods'
import type * as podsModule from '#drivers/k8s/substrate/pods'
// The listing joins DB rows with what is read off disk (live runtimes,
// transcripts for prompts and last-activity stamps). Only pod listing is
// mocked; the rest runs for real.
import {
  recordWorkspaceCreated,
  recordWorkspaceStopped,
  setWorkspaceTitle,
} from '#db/workspace-store'
import { createWorkspaceGroup } from '#db/group-store'
import { listWorkspaceAgentSessions, recordAgentSessions } from '#db/agent-session-store'
import { closeDb } from '#db/client'
import { recordProject } from '#db/project-store'
import { claudeDir, getProjectsDir } from '@yaac/shared/project-paths'
import { listStoppedWorkspaces } from '#domain/workspaces/stopped-list'
import type { AgentTool, ProjectMeta } from '@yaac/shared/types'

const mockListPods = vi.mocked(listWorkspacePods)

async function writeProject(slug: string, meta: Partial<ProjectMeta> = {}): Promise<void> {
  const full: ProjectMeta = {
    slug,
    remoteUrl: meta.remoteUrl ?? `https://example.com/${slug}`,
    addedAt: meta.addedAt ?? '2026-01-01T00:00:00.000Z',
  }
  const dir = path.join(getProjectsDir(), slug)
  await fs.mkdir(dir, { recursive: true })
  await recordProject(full)
}

/** Record a workspace, its first conversation, and optionally its stop. */
async function seedWorkspace(
  slug: string,
  workspaceId: string,
  opts: { tool?: AgentTool; deleted?: boolean } = {},
): Promise<void> {
  await recordWorkspaceCreated({ projectSlug: slug, workspaceId })
  // A real create always records a conversation, which is where the tool
  // and first prompt are read from.
  await recordAgentSessions(slug, workspaceId, [
    { tool: opts.tool ?? 'claude', agentSessionId: workspaceId },
  ])
  if (opts.deleted) await recordWorkspaceStopped(slug, workspaceId)
}

function activePod(slug: string, workspaceId: string): podsModule.PodInfo {
  return {
    jobName: `yaac-${slug}-${workspaceId}`,
    podName: `yaac-${slug}-${workspaceId}-x1`,
    workspaceId,
    projectSlug: slug,
    projectId: '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 0,
    labels: {},
  }
}

describe('listStoppedWorkspaces', () => {
  let tmpDir: string

  beforeEach(async () => {
    installRealWorkspaceDriver()
    tmpDir = await createTempDataDir()
    mockListPods.mockReset()
    mockListPods.mockResolvedValue([])
    await writeProject('demo')
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the project filter points at an unknown slug', async () => {
    await expect(listStoppedWorkspaces('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns [] when nothing has been recorded', async () => {
    expect(await listStoppedWorkspaces()).toEqual([])
  })

  it('lists recorded sessions that have no active pod', async () => {
    await seedWorkspace('demo', 'aaaaaa', { deleted: true })
    const result = await listStoppedWorkspaces('demo')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      workspaceId: 'aaaaaa',
      projectSlug: 'demo',
      tool: 'claude',
    })
    expect(result[0]?.stoppedAt).toBeDefined()
  })

  it('skips sessions that still have an active pod', async () => {
    await seedWorkspace('demo', 'active1')
    mockListPods.mockResolvedValue([activePod('demo', 'active1')])
    expect(await listStoppedWorkspaces('demo')).toEqual([])
  })

  it('treats every recorded session as deleted when the cluster is unreachable', async () => {
    await seedWorkspace('demo', 'active1')
    mockListPods.mockRejectedValue(new Error('cluster down'))
    expect((await listStoppedWorkspaces('demo')).map((r) => r.workspaceId)).toEqual(['active1'])
  })

  it('filters by project', async () => {
    await writeProject('other')
    await seedWorkspace('demo', 'here', { deleted: true })
    await seedWorkspace('other', 'elsewhere', { deleted: true })
    expect((await listStoppedWorkspaces('demo')).map((r) => r.workspaceId)).toEqual(['here'])
    expect((await listStoppedWorkspaces()).map((r) => r.workspaceId).sort()).toEqual(['elsewhere', 'here'])
  })

  it('orders by recorded deletion time, newest first', async () => {
    await seedWorkspace('demo', 'first', { deleted: true })
    await new Promise((r) => setTimeout(r, 5))
    await seedWorkspace('demo', 'second', { deleted: true })
    expect((await listStoppedWorkspaces('demo')).map((r) => r.workspaceId)).toEqual(['second', 'first'])
  })

  it('orders a session removed out of band by its last activity', async () => {
    // `busy` and `idle` have no recorded stop, so each sorts by last
    // activity: `idle` (no transcript) by its creation, just before `recent`
    // stopped, and `busy` (created first) by a transcript written after both.
    const dir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(dir, { recursive: true })
    const transcript = path.join(dir, 'busy.jsonl')
    await fs.writeFile(transcript, '{}\n')
    await seedWorkspace('demo', 'busy')
    await recordAgentSessions('demo', 'busy', [{
      tool: 'claude',
      agentSessionId: 'busy',
      transcriptPath: path.join('claude', 'projects', '-workspace', 'busy.jsonl'),
    }])
    await new Promise((r) => setTimeout(r, 5))
    await seedWorkspace('demo', 'idle', { tool: 'opencode' })
    await new Promise((r) => setTimeout(r, 5))
    await seedWorkspace('demo', 'recent', { deleted: true })
    const later = new Date(Date.now() + 60_000)
    await fs.utimes(transcript, later, later)

    const result = await listStoppedWorkspaces('demo')
    expect(result.map((r) => r.workspaceId)).toEqual(['busy', 'recent', 'idle'])
    expect(result.find((r) => r.workspaceId === 'idle')?.stoppedAt).toBeUndefined()
  })

  it('carries the recorded death cause and its seen flag on the entry', async () => {
    await seedWorkspace('demo', 'died')
    await seedWorkspace('demo', 'removed')
    await recordWorkspaceStopped('demo', 'died', { reason: 'oom', detail: 'exit code 137' })
    await recordWorkspaceStopped('demo', 'removed')
    const result = await listStoppedWorkspaces('demo')
    const died = result.find((r) => r.workspaceId === 'died')
    expect(died).toMatchObject({ deathReason: 'oom', deathDetail: 'exit code 137', seen: false })
    const removed = result.find((r) => r.workspaceId === 'removed')
    expect(removed?.deathReason).toBeUndefined()
    expect(removed?.deathDetail).toBeUndefined()
  })

  it('carries the title and the sidebar group', async () => {
    await seedWorkspace('demo', 'sid', { deleted: true })
    await setWorkspaceTitle('demo', 'sid', 'fix the parser')
    const group = await createWorkspaceGroup('demo', 'release', 'sid')
    expect((await listStoppedWorkspaces('demo'))[0]).toMatchObject({
      title: 'fix the parser',
      groupId: group.groupId,
    })
  })

  it('caps results to the requested limit after sorting newest-first', async () => {
    for (let i = 0; i < 5; i++) {
      await seedWorkspace('demo', `s${i}`, { deleted: true })
      await new Promise((r) => setTimeout(r, 5))
    }
    const result = await listStoppedWorkspaces('demo', 2)
    expect(result.map((r) => r.workspaceId)).toEqual(['s4', 's3'])
  })

  it('keeps a grouped session past the cap so its ghost row survives', async () => {
    await seedWorkspace('demo', 'grouped', { deleted: true })
    await createWorkspaceGroup('demo', 'release', 'grouped')
    await new Promise((r) => setTimeout(r, 5))
    for (const id of ['a', 'b', 'c']) {
      await seedWorkspace('demo', id, { deleted: true })
      await new Promise((r) => setTimeout(r, 5))
    }
    const result = await listStoppedWorkspaces('demo', 2)
    expect(result.map((r) => r.workspaceId).sort()).toEqual(['b', 'c', 'grouped'])
  })

  it('returns all entries when limit is 0 or undefined', async () => {
    for (const id of ['a', 'b', 'c']) await seedWorkspace('demo', id, { deleted: true })
    expect(await listStoppedWorkspaces('demo')).toHaveLength(3)
    expect(await listStoppedWorkspaces('demo', 0)).toHaveLength(3)
  })

  it('reports last activity from the transcript, and creation time without one', async () => {
    const workspacesDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(workspacesDir, { recursive: true })
    const transcript = path.join(workspacesDir, 'withlog.jsonl')
    await fs.writeFile(transcript, '{}\n')
    await fs.utimes(transcript, new Date('2026-01-02'), new Date('2026-01-02'))
    await seedWorkspace('demo', 'withlog', { deleted: true })
    // Last activity comes from the workspace's conversations. The path is
    // relative, as discovery records it; an absolute one would be refused and
    // the listing would fall back to the conventional path, so the test
    // would not check the recorded path at all.
    await recordAgentSessions('demo', 'withlog', [
      {
        tool: 'claude',
        agentSessionId: 'withlog',
        transcriptPath: path.join('claude', 'projects', '-workspace', 'withlog.jsonl'),
        firstPrompt: 'hi',
      },
    ])
    await seedWorkspace('demo', 'nolog', { tool: 'opencode', deleted: true })

    const result = await listStoppedWorkspaces('demo')
    expect(result.find((r) => r.workspaceId === 'withlog')?.lastActiveAt).toBe('2026-01-02 00:00:00')
    const nolog = result.find((r) => r.workspaceId === 'nolog')
    expect(nolog?.lastActiveAt).toBe(nolog?.createdAt)
  })

  it('parses the prompt on demand for a session that died before capture, then keeps it', async () => {
    const workspacesDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(workspacesDir, { recursive: true })
    const first = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello there' } })
    await fs.writeFile(path.join(workspacesDir, 'a.jsonl'), `${first}\n`)
    await seedWorkspace('demo', 'a', { deleted: true })

    expect((await listStoppedWorkspaces('demo'))[0]?.prompt).toBe('hello there')
    // The parse read an absolute path but must record the relative form.
    const [link] = await listWorkspaceAgentSessions('demo', 'a')
    expect(link?.transcriptPath).toBe(path.join('claude', 'projects', '-workspace', 'a.jsonl'))
    // The prompt is persisted, so it survives the transcript's removal.
    await fs.rm(path.join(workspacesDir, 'a.jsonl'))
    expect((await listStoppedWorkspaces('demo'))[0]?.prompt).toBe('hello there')
  })

  it('leaves the prompt unset for an opencode session that was never captured', async () => {
    await seedWorkspace('demo', 'ocsess', { tool: 'opencode', deleted: true })
    expect((await listStoppedWorkspaces('demo'))[0]).toMatchObject({
      workspaceId: 'ocsess',
      tool: 'opencode',
    })
    expect((await listStoppedWorkspaces('demo'))[0]?.prompt).toBeUndefined()
  })
})
