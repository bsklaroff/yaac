import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installRealWorktreeRuntime } from '@yaac/test-utils/real-runtime'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

vi.mock('#runtime/k8s/substrate/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listWorktreePods: vi.fn().mockResolvedValue([]),
  }
})

import { listWorktreePods } from '#runtime/k8s/substrate/pods'
import type * as podsModule from '#runtime/k8s/substrate/pods'
// The listing is a join: the rows are the server's, and which of them still
// have a runtime — plus every transcript read behind a prompt or a
// last-activity stamp — is read off disk. Its real halves stand behind the
// boundary here, so the leaf mocks above still drive them.
import {
  recordWorktreeCreated,
  recordWorktreeStopped,
  setWorktreeBackground,
  setWorktreeTitle,
} from '#db/worktree-store'
import { listWorktreeAgentSessions, recordAgentSessions } from '#db/agent-session-store'
import { closeDb } from '#db/client'
import { claudeDir, getProjectsDir } from '@yaac/shared/project-paths'
import { listStoppedWorktrees } from '#domain/worktrees/stopped-list'
import type { AgentTool, ProjectMeta } from '@yaac/shared/types'

const mockListPods = vi.mocked(listWorktreePods)

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
async function seedWorktree(
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

function activePod(slug: string, worktreeId: string): podsModule.PodInfo {
  return {
    jobName: `yaac-${slug}-${worktreeId}`,
    podName: `yaac-${slug}-${worktreeId}-x1`,
    worktreeId,
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
    installRealWorktreeRuntime()
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
    await seedWorktree('demo', 'aaaaaa', { deleted: true })
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
    await seedWorktree('demo', 'active1')
    mockListPods.mockResolvedValue([activePod('demo', 'active1')])
    expect(await listStoppedWorktrees('demo')).toEqual([])
  })

  it('treats every recorded session as deleted when the cluster is unreachable', async () => {
    await seedWorktree('demo', 'active1')
    mockListPods.mockRejectedValue(new Error('cluster down'))
    expect((await listStoppedWorktrees('demo')).map((r) => r.worktreeId)).toEqual(['active1'])
  })

  it('filters by project', async () => {
    await writeProject('other')
    await seedWorktree('demo', 'here', { deleted: true })
    await seedWorktree('other', 'elsewhere', { deleted: true })
    expect((await listStoppedWorktrees('demo')).map((r) => r.worktreeId)).toEqual(['here'])
    expect((await listStoppedWorktrees()).map((r) => r.worktreeId).sort()).toEqual(['elsewhere', 'here'])
  })

  it('orders by recorded deletion time, newest first', async () => {
    await seedWorktree('demo', 'first', { deleted: true })
    await new Promise((r) => setTimeout(r, 5))
    await seedWorktree('demo', 'second', { deleted: true })
    expect((await listStoppedWorktrees('demo')).map((r) => r.worktreeId)).toEqual(['second', 'first'])
  })

  it('falls back to creation time for a session removed out of band', async () => {
    // `old` was created first but never recorded as deleted; `recent` was
    // deleted just now. Newest-deleted-first ⇒ recent before old.
    await seedWorktree('demo', 'old')
    await new Promise((r) => setTimeout(r, 5))
    await seedWorktree('demo', 'recent', { deleted: true })
    const result = await listStoppedWorktrees('demo')
    expect(result.map((r) => r.worktreeId)).toEqual(['recent', 'old'])
    expect(result.find((r) => r.worktreeId === 'old')?.stoppedAt).toBeUndefined()
  })

  it('carries the recorded death cause and its seen flag on the entry', async () => {
    await seedWorktree('demo', 'died')
    await seedWorktree('demo', 'removed')
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
    await seedWorktree('demo', 'sid', { deleted: true })
    await setWorktreeTitle('demo', 'sid', 'fix the parser')
    await setWorktreeBackground('demo', 'sid', true)
    expect((await listStoppedWorktrees('demo'))[0]).toMatchObject({
      title: 'fix the parser',
      background: true,
    })
  })

  it('caps results to the requested limit after sorting newest-first', async () => {
    for (let i = 0; i < 5; i++) {
      await seedWorktree('demo', `s${i}`, { deleted: true })
      await new Promise((r) => setTimeout(r, 5))
    }
    const result = await listStoppedWorktrees('demo', 2)
    expect(result.map((r) => r.worktreeId)).toEqual(['s4', 's3'])
  })

  it('keeps a pinned session past the cap so its sidebar row survives', async () => {
    await seedWorktree('demo', 'pinned', { deleted: true })
    await setWorktreeBackground('demo', 'pinned', true)
    await new Promise((r) => setTimeout(r, 5))
    for (const id of ['a', 'b', 'c']) {
      await seedWorktree('demo', id, { deleted: true })
      await new Promise((r) => setTimeout(r, 5))
    }
    const result = await listStoppedWorktrees('demo', 2)
    expect(result.map((r) => r.worktreeId).sort()).toEqual(['b', 'c', 'pinned'])
  })

  it('returns all entries when limit is 0 or undefined', async () => {
    for (const id of ['a', 'b', 'c']) await seedWorktree('demo', id, { deleted: true })
    expect(await listStoppedWorktrees('demo')).toHaveLength(3)
    expect(await listStoppedWorktrees('demo', 0)).toHaveLength(3)
  })

  it('reports last activity from the transcript, and creation time without one', async () => {
    const worktreesDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(worktreesDir, { recursive: true })
    const transcript = path.join(worktreesDir, 'withlog.jsonl')
    await fs.writeFile(transcript, '{}\n')
    await fs.utimes(transcript, new Date('2026-01-02'), new Date('2026-01-02'))
    await seedWorktree('demo', 'withlog', { deleted: true })
    // Last-activity now comes from the worktree's conversations, so the
    // transcript is attached to one rather than to the row. Recorded in the
    // column's form, as discovery reports it: an absolute here would be
    // refused on the way back out, and the listing would still pass by
    // falling back to the conventional path for the same file — reporting
    // nothing about whether the recorded path works.
    await recordAgentSessions('demo', 'withlog', [
      {
        tool: 'claude',
        agentSessionId: 'withlog',
        transcriptPath: path.join('claude', 'projects', '-workspace', 'withlog.jsonl'),
        firstPrompt: 'hi',
      },
    ])
    await seedWorktree('demo', 'nolog', { tool: 'opencode', deleted: true })

    const result = await listStoppedWorktrees('demo')
    expect(result.find((r) => r.worktreeId === 'withlog')?.lastActiveAt).toBe('2026-01-02 00:00:00')
    const nolog = result.find((r) => r.worktreeId === 'nolog')
    expect(nolog?.lastActiveAt).toBe(nolog?.createdAt)
  })

  it('parses the prompt on demand for a session that died before capture, then keeps it', async () => {
    const worktreesDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(worktreesDir, { recursive: true })
    const first = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello there' } })
    await fs.writeFile(path.join(worktreesDir, 'a.jsonl'), `${first}\n`)
    await seedWorktree('demo', 'a', { deleted: true })

    expect((await listStoppedWorktrees('demo'))[0]?.prompt).toBe('hello there')
    // The write door this parse goes out through: the path it read is the
    // absolute conventional one, and what lands in the column is the portable
    // form. Nothing else here would notice an absolute — the prompt is
    // persisted too, so the assertion below answers from the row either way.
    const [link] = await listWorktreeAgentSessions('demo', 'a')
    expect(link?.transcriptPath).toBe(path.join('claude', 'projects', '-workspace', 'a.jsonl'))
    // Persisted, so the second listing answers from the row: removing the
    // transcript can't take the prompt away.
    await fs.rm(path.join(worktreesDir, 'a.jsonl'))
    expect((await listStoppedWorktrees('demo'))[0]?.prompt).toBe('hello there')
  })

  it('leaves the prompt unset for an opencode session that was never captured', async () => {
    await seedWorktree('demo', 'ocsess', { tool: 'opencode', deleted: true })
    expect((await listStoppedWorktrees('demo'))[0]).toMatchObject({
      worktreeId: 'ocsess',
      tool: 'opencode',
    })
    expect((await listStoppedWorktrees('demo'))[0]?.prompt).toBeUndefined()
  })
})
