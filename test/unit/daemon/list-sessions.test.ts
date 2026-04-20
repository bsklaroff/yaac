import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { claudeDir, getProjectsDir, projectDir } from '@/lib/project/paths'
import { listActiveSessions, listDeletedSessions } from '@/lib/session/list'
import { DaemonError } from '@/daemon/errors'
import type { ProjectMeta } from '@/types'

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

describe('listActiveSessions', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when the project filter points at an unknown slug', async () => {
    await expect(listActiveSessions('does-not-exist')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns empty arrays with no containers and no prewarm state', async () => {
    const result = await listActiveSessions()
    expect(result.sessions).toEqual([])
    expect(result.stale).toEqual([])
    expect(result.failedPrewarms).toEqual([])
  })

  it('surfaces failed prewarms from the state file', async () => {
    await writeProject('foo')
    const prewarmFile = path.join(tmpDir, '.prewarm-sessions.json')
    const entry = {
      sessionId: 'abc',
      containerName: 'yaac-foo-abc',
      fingerprint: 'fp-1',
      state: 'failed' as const,
      verifiedAt: 1_700_000_000_000,
    }
    await fs.writeFile(prewarmFile, JSON.stringify({ foo: entry }))
    const result = await listActiveSessions('foo')
    expect(result.failedPrewarms).toEqual([
      { slug: 'foo', fingerprint: 'fp-1', verifiedAt: 1_700_000_000_000 },
    ])
  })
})

describe('listDeletedSessions', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
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

  it('enumerates Claude JSONL sessions that have no active container', async () => {
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

  it('sorts newest first', async () => {
    await writeProject('demo')
    const sessionsDir = path.join(claudeDir('demo'), 'projects', '-workspace')
    await fs.mkdir(sessionsDir, { recursive: true })
    const oldPath = path.join(sessionsDir, 'old.jsonl')
    const newPath = path.join(sessionsDir, 'new.jsonl')
    await fs.writeFile(oldPath, '{}\n')
    await fs.writeFile(newPath, '{}\n')
    // Backdate the first file so lstat.birthtime sorts it older.
    await fs.utimes(oldPath, new Date('2026-01-01'), new Date('2026-01-01'))
    const result = await listDeletedSessions('demo')
    expect(result.map((r) => r.sessionId)).toEqual(['new', 'old'])
  })
})

describe('listActiveSessions project filter', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('accepts the project filter when project.json exists', async () => {
    await fs.mkdir(projectDir('valid'), { recursive: true })
    await fs.writeFile(
      path.join(projectDir('valid'), 'project.json'),
      JSON.stringify({ slug: 'valid', remoteUrl: 'x', addedAt: 'y' }),
    )
    const result = await listActiveSessions('valid')
    expect(result.sessions).toEqual([])
  })

  it('raises DaemonError for unknown projects', async () => {
    await expect(listActiveSessions('bogus')).rejects.toBeInstanceOf(DaemonError)
  })
})
