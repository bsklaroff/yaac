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
import * as opencodeStatus from '#features/sessions/agents/opencode'
import { recordSessionDeleted } from '#features/sessions/deleted-store'
import { closeDb } from '#platform/db/client'
import { claudeDir, getProjectsDir } from '@yaac/shared/project-paths'
import { listDeletedSessions } from '#features/sessions/deleted-list'
import type { ProjectMeta } from '@yaac/shared/types'

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

describe('listDeletedSessions', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    mockListPods.mockReset()
    mockListPods.mockResolvedValue([])
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the project filter points at an unknown slug', async () => {
    await expect(listDeletedSessions('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns [] when no projects exist', async () => {
    await fs.rm(getProjectsDir(), { recursive: true, force: true })
    const result = await listDeletedSessions()
    expect(result).toEqual([])
  })

  it('enumerates Claude JSONL sessions that have no active pod', async () => {
    await writeProject('demo')
    const sessionsDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    await fs.writeFile(path.join(sessionsDir, 'aaaaaa.jsonl'), '{}\n')
    await fs.writeFile(path.join(sessionsDir, 'ignoreme.txt'), 'not jsonl')
    const result = await listDeletedSessions('demo')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      sessionId: 'aaaaaa',
      projectSlug: 'demo',
      tool: 'claude',
    })
  })

  it('skips sessions that still have an active pod', async () => {
    await writeProject('demo')
    const sessionsDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    await fs.writeFile(path.join(sessionsDir, 'active1.jsonl'), '{}\n')
    mockListPods.mockResolvedValue([{
      jobName: 'yaac-demo-active1',
      podName: 'yaac-demo-active1-x1',
      sessionId: 'active1',
      projectSlug: 'demo',
      tool: 'claude',
      phase: 'Running',
      running: true,
      terminating: false,
      createdAtMs: 0,
      labels: {},
    }])
    const result = await listDeletedSessions('demo')
    expect(result).toEqual([])
  })

  it('sorts by last activity (mtime) newest-first when nothing was recorded', async () => {
    await writeProject('demo')
    const sessionsDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    const oldPath = path.join(sessionsDir, 'old.jsonl')
    const newPath = path.join(sessionsDir, 'new.jsonl')
    await fs.writeFile(oldPath, '{}\n')
    await fs.writeFile(newPath, '{}\n')
    // Backdate the first file's mtime so it reads as less-recently-active.
    await fs.utimes(oldPath, new Date('2026-01-01'), new Date('2026-01-01'))
    const result = await listDeletedSessions('demo')
    expect(result.map((r) => r.sessionId)).toEqual(['new', 'old'])
    // Every entry carries its last-activity time (the mtime it sorted by).
    expect(result.every((r) => typeof r.lastActiveAt === 'string')).toBe(true)
  })

  it('orders by recorded deletion time ahead of raw last activity', async () => {
    await writeProject('demo')
    const sessionsDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    await fs.writeFile(path.join(sessionsDir, 'a.jsonl'), '{}\n')
    await fs.writeFile(path.join(sessionsDir, 'b.jsonl'), '{}\n')
    // `a` was last active long ago but deleted just now; `b` was active more
    // recently but has no recorded deletion. Newest-deleted-first ⇒ a before b.
    await fs.utimes(path.join(sessionsDir, 'a.jsonl'), new Date('2026-01-01'), new Date('2026-01-01'))
    await fs.utimes(path.join(sessionsDir, 'b.jsonl'), new Date('2026-06-01'), new Date('2026-06-01'))
    await recordSessionDeleted('demo', 'a')
    const result = await listDeletedSessions('demo')
    expect(result.map((r) => r.sessionId)).toEqual(['a', 'b'])
    expect(result.find((r) => r.sessionId === 'a')?.deletedAt).toBeDefined()
    expect(result.find((r) => r.sessionId === 'b')?.deletedAt).toBeUndefined()
  })

  it('carries the recorded death cause on the entry', async () => {
    await writeProject('demo')
    const sessionsDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    await fs.writeFile(path.join(sessionsDir, 'died.jsonl'), '{}\n')
    await fs.writeFile(path.join(sessionsDir, 'removed.jsonl'), '{}\n')
    await recordSessionDeleted('demo', 'died', { reason: 'oom', detail: 'exit code 137' })
    await recordSessionDeleted('demo', 'removed')
    const result = await listDeletedSessions('demo')
    const died = result.find((r) => r.sessionId === 'died')
    expect(died?.deathReason).toBe('oom')
    expect(died?.deathDetail).toBe('exit code 137')
    const removed = result.find((r) => r.sessionId === 'removed')
    expect(removed?.deathReason).toBeUndefined()
    expect(removed?.deathDetail).toBeUndefined()
  })

  it('caps results to the requested limit after sorting newest-first', async () => {
    await writeProject('demo')
    const sessionsDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    for (let i = 0; i < 5; i++) {
      const p = path.join(sessionsDir, `s${i}.jsonl`)
      await fs.writeFile(p, '{}\n')
      // On Linux fs.utimes does not affect birthtime, so rely on actual
      // creation order with a small gap to keep ms-level sort deterministic.
      await new Promise((r) => setTimeout(r, 5))
    }
    const result = await listDeletedSessions('demo', 2)
    expect(result.map((r) => r.sessionId)).toEqual(['s4', 's3'])
  })

  it('returns all entries when limit is 0 or undefined', async () => {
    await writeProject('demo')
    const sessionsDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    for (const id of ['a', 'b', 'c']) {
      await fs.writeFile(path.join(sessionsDir, `${id}.jsonl`), '{}\n')
    }
    const noLimit = await listDeletedSessions('demo')
    const zeroLimit = await listDeletedSessions('demo', 0)
    expect(noLimit).toHaveLength(3)
    expect(zeroLimit).toHaveLength(3)
  })

  it('enumerates opencode sessions from the meta cache with no active pod', async () => {
    await writeProject('demo')
    await opencodeStatus.saveOpencodeMeta('demo', 'ocsess', {
      firstMessage: 'build a thing',
      capturedAt: '2026-05-01T00:00:00.000Z',
    })
    const result = await listDeletedSessions('demo')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      sessionId: 'ocsess',
      projectSlug: 'demo',
      tool: 'opencode',
      prompt: 'build a thing',
    })
  })

  it('populates prompt from the first user message in the Claude transcript', async () => {
    await writeProject('demo')
    const sessionsDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    const first = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello there' } })
    await fs.writeFile(path.join(sessionsDir, 'a.jsonl'), `${first}\n`)
    const result = await listDeletedSessions('demo')
    expect(result[0]?.prompt).toBe('hello there')
  })
})
