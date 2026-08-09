import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

vi.mock('#platform/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn().mockResolvedValue([]),
  }
})

import { listSessionPods } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import {
  recordWorktreeCreated,
  recordWorktreeStopped,
  setWorktreeBackground,
  setWorktreeTitle,
} from '#features/records/worktree-store'
import { recordAgentSessions } from '#features/records/agent-session-store'
import { closeDb } from '#platform/db/client'
import { claudeDir, getProjectsDir } from '@yaac/shared/project-paths'
import { listStoppedWorktrees } from '#features/sessions/stopped-list'
import type { AgentTool, ProjectMeta } from '@yaac/shared/types'

const mockListPods = vi.mocked(listSessionPods)

async function writeProject(slug: string, meta: Partial<ProjectMeta> = {}): Promise<void> {
  const full: ProjectMeta = {
    slug,
    remoteUrl: meta.remoteUrl ?? `https://example.com/${slug}`,
    addedAt: meta.addedAt ?? '2026-01-01T00:00:00.000Z',
  }
  const dir = path.join(getProjectsDir(), slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(full))
}

/** Record a worktree, then (optionally) its stop — the two writes every
 *  row in the stopped listing has been through. */
async function seedSession(
  slug: string,
  worktreeId: string,
  opts: { tool?: AgentTool; deleted?: boolean } = {},
): Promise<void> {
  await recordWorktreeCreated({ projectSlug: slug, worktreeId })
  // Session create records the conversation it launches alongside the row —
  // that is where the worktree's tool and founding ask are read from, so a
  // fixture without one is a worktree that could never have existed.
  await recordAgentSessions(slug, worktreeId, [
    { tool: opts.tool ?? 'claude', agentSessionId: worktreeId },
  ])
  if (opts.deleted) await recordWorktreeStopped(slug, worktreeId)
}

function activePod(slug: string, sessionId: string): podsModule.SessionPod {
  return {
    jobName: `yaac-${slug}-${sessionId}`,
    podName: `yaac-${slug}-${sessionId}-x1`,
    sessionId,
    projectSlug: slug,
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 0,
    labels: {},
  }
}

describe('listStoppedWorktrees', () => {
  let tmpDir: string

  beforeEach(async () => {
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
    await expect(listStoppedWorktrees('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns [] when nothing has been recorded', async () => {
    expect(await listStoppedWorktrees()).toEqual([])
  })

  it('lists recorded sessions that have no active pod', async () => {
    await seedSession('demo', 'aaaaaa', { deleted: true })
    const result = await listStoppedWorktrees('demo')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      worktreeId: 'aaaaaa',
      projectSlug: 'demo',
      tool: 'claude',
    })
    expect(result[0]?.stoppedAt).toBeDefined()
  })

  it('skips sessions that still have an active pod', async () => {
    await seedSession('demo', 'active1')
    mockListPods.mockResolvedValue([activePod('demo', 'active1')])
    expect(await listStoppedWorktrees('demo')).toEqual([])
  })

  it('treats every recorded session as deleted when the cluster is unreachable', async () => {
    await seedSession('demo', 'active1')
    mockListPods.mockRejectedValue(new Error('cluster down'))
    expect((await listStoppedWorktrees('demo')).map((r) => r.worktreeId)).toEqual(['active1'])
  })

  it('filters by project', async () => {
    await writeProject('other')
    await seedSession('demo', 'here', { deleted: true })
    await seedSession('other', 'elsewhere', { deleted: true })
    expect((await listStoppedWorktrees('demo')).map((r) => r.worktreeId)).toEqual(['here'])
    expect((await listStoppedWorktrees()).map((r) => r.worktreeId).sort()).toEqual(['elsewhere', 'here'])
  })

  it('orders by recorded deletion time, newest first', async () => {
    await seedSession('demo', 'first', { deleted: true })
    await new Promise((r) => setTimeout(r, 5))
    await seedSession('demo', 'second', { deleted: true })
    expect((await listStoppedWorktrees('demo')).map((r) => r.worktreeId)).toEqual(['second', 'first'])
  })

  it('falls back to creation time for a session removed out of band', async () => {
    // `old` was created first but never recorded as deleted; `recent` was
    // deleted just now. Newest-deleted-first ⇒ recent before old.
    await seedSession('demo', 'old')
    await new Promise((r) => setTimeout(r, 5))
    await seedSession('demo', 'recent', { deleted: true })
    const result = await listStoppedWorktrees('demo')
    expect(result.map((r) => r.worktreeId)).toEqual(['recent', 'old'])
    expect(result.find((r) => r.worktreeId === 'old')?.stoppedAt).toBeUndefined()
  })

  it('carries the recorded death cause and its seen flag on the entry', async () => {
    await seedSession('demo', 'died')
    await seedSession('demo', 'removed')
    await recordWorktreeStopped('demo', 'died', { reason: 'oom', detail: 'exit code 137' })
    await recordWorktreeStopped('demo', 'removed')
    const result = await listStoppedWorktrees('demo')
    const died = result.find((r) => r.worktreeId === 'died')
    expect(died).toMatchObject({ deathReason: 'oom', deathDetail: 'exit code 137', seen: false })
    const removed = result.find((r) => r.worktreeId === 'removed')
    expect(removed?.deathReason).toBeUndefined()
    expect(removed?.deathDetail).toBeUndefined()
  })

  it('carries the title and background pin', async () => {
    await seedSession('demo', 'sid', { deleted: true })
    await setWorktreeTitle('demo', 'sid', 'fix the parser')
    await setWorktreeBackground('demo', 'sid', true)
    expect((await listStoppedWorktrees('demo'))[0]).toMatchObject({
      title: 'fix the parser',
      background: true,
    })
  })

  it('caps results to the requested limit after sorting newest-first', async () => {
    for (let i = 0; i < 5; i++) {
      await seedSession('demo', `s${i}`, { deleted: true })
      await new Promise((r) => setTimeout(r, 5))
    }
    const result = await listStoppedWorktrees('demo', 2)
    expect(result.map((r) => r.worktreeId)).toEqual(['s4', 's3'])
  })

  it('keeps a pinned session past the cap so its sidebar row survives', async () => {
    await seedSession('demo', 'pinned', { deleted: true })
    await setWorktreeBackground('demo', 'pinned', true)
    await new Promise((r) => setTimeout(r, 5))
    for (const id of ['a', 'b', 'c']) {
      await seedSession('demo', id, { deleted: true })
      await new Promise((r) => setTimeout(r, 5))
    }
    const result = await listStoppedWorktrees('demo', 2)
    expect(result.map((r) => r.worktreeId).sort()).toEqual(['b', 'c', 'pinned'])
  })

  it('returns all entries when limit is 0 or undefined', async () => {
    for (const id of ['a', 'b', 'c']) await seedSession('demo', id, { deleted: true })
    expect(await listStoppedWorktrees('demo')).toHaveLength(3)
    expect(await listStoppedWorktrees('demo', 0)).toHaveLength(3)
  })

  it('reports last activity from the transcript, and creation time without one', async () => {
    const sessionsDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    const transcript = path.join(sessionsDir, 'withlog.jsonl')
    await fs.writeFile(transcript, '{}\n')
    await fs.utimes(transcript, new Date('2026-01-02'), new Date('2026-01-02'))
    await seedSession('demo', 'withlog', { deleted: true })
    // Last-activity now comes from the worktree's conversations, so the
    // transcript is attached to one rather than to the row.
    await recordAgentSessions('demo', 'withlog', [
      { tool: 'claude', agentSessionId: 'withlog', transcriptPath: transcript, firstPrompt: 'hi' },
    ])
    await seedSession('demo', 'nolog', { tool: 'opencode', deleted: true })

    const result = await listStoppedWorktrees('demo')
    expect(result.find((r) => r.worktreeId === 'withlog')?.lastActiveAt).toBe('2026-01-02 00:00:00')
    const nolog = result.find((r) => r.worktreeId === 'nolog')
    expect(nolog?.lastActiveAt).toBe(nolog?.createdAt)
  })

  it('parses the prompt on demand for a session that died before capture, then keeps it', async () => {
    const sessionsDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    const first = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello there' } })
    await fs.writeFile(path.join(sessionsDir, 'a.jsonl'), `${first}\n`)
    await seedSession('demo', 'a', { deleted: true })

    expect((await listStoppedWorktrees('demo'))[0]?.prompt).toBe('hello there')
    // Persisted, so the second listing answers from the row: removing the
    // transcript can't take the prompt away.
    await fs.rm(path.join(sessionsDir, 'a.jsonl'))
    expect((await listStoppedWorktrees('demo'))[0]?.prompt).toBe('hello there')
  })

  it('leaves the prompt unset for an opencode session that was never captured', async () => {
    await seedSession('demo', 'ocsess', { tool: 'opencode', deleted: true })
    expect((await listStoppedWorktrees('demo'))[0]).toMatchObject({
      worktreeId: 'ocsess',
      tool: 'opencode',
    })
    expect((await listStoppedWorktrees('demo'))[0]?.prompt).toBeUndefined()
  })
})
